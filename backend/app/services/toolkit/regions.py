"""Multi-region design: where to run, what has to be copied between regions, how latency changes for users, and
what failing over looks like. Also builds a ready-made multi-region variant of the design.

Latency is an estimate from the distance between regions (see `rtt_ms`); replication lag and recovery notes are
typical figures, not measurements.
"""

from __future__ import annotations

import math

from app.schemas.models import (
    ArchitectureComponent,
    ArchitectureConnection,
    ArchitecturePatch,
    ArchitectureResult,
    ComponentUpdate,
)
from app.schemas.toolkit import (
    LatencyRow,
    MultiRegionRequest,
    MultiRegionResponse,
    RegionInfo,
    ReplicationLink,
)
from app.services.patch import apply_patch
from app.services.toolkit.common import Context, build_context, some

MAX_COMPONENTS = 100

# code: (name, latitude, longitude)
REGIONS: dict[str, tuple[str, float, float]] = {
    "us-east-1": ("N. Virginia", 38.9, -77.5),
    "us-east-2": ("Ohio", 40.0, -83.0),
    "us-west-1": ("N. California", 37.4, -121.9),
    "us-west-2": ("Oregon", 45.8, -119.7),
    "ca-central-1": ("Canada (Montreal)", 45.5, -73.6),
    "sa-east-1": ("Sao Paulo", -23.5, -46.6),
    "eu-west-1": ("Ireland", 53.3, -6.3),
    "eu-west-2": ("London", 51.5, -0.1),
    "eu-central-1": ("Frankfurt", 50.1, 8.7),
    "eu-north-1": ("Stockholm", 59.3, 18.1),
    "me-south-1": ("Bahrain", 26.2, 50.6),
    "af-south-1": ("Cape Town", -33.9, 18.4),
    "ap-south-1": ("Mumbai", 19.1, 72.9),
    "ap-southeast-1": ("Singapore", 1.3, 103.8),
    "ap-southeast-2": ("Sydney", -33.9, 151.2),
    "ap-northeast-1": ("Tokyo", 35.7, 139.7),
    "ap-northeast-2": ("Seoul", 37.6, 127.0),
}


def region_list() -> list[RegionInfo]:
    return [RegionInfo(code=code, name=name) for code, (name, _, _) in REGIONS.items()]


def distance_km(a: str, b: str) -> float:
    """Great-circle distance between two regions."""
    (_, lat1, lon1), (_, lat2, lon2) = REGIONS[a], REGIONS[b]
    p1, p2 = math.radians(lat1), math.radians(lat2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def rtt_ms(a: str, b: str) -> float:
    """Estimated round-trip time: light in fiber covers about 200 km per millisecond one way, real routes are
    about 1.5 times longer than the straight line, and each end adds a few milliseconds."""
    if a == b:
        return 2.0
    return round(2 * distance_km(a, b) * 1.5 / 200 + 3, 1)


def _check(code: str) -> str:
    if code not in REGIONS:
        raise ValueError(f"'{code}' is not a region this tool knows. Choose from: {', '.join(REGIONS)}")
    return code


def _replicate(
    ctx: Context, primary: str, secondaries: list[str], mode: str
) -> tuple[ArchitectureResult | None, list[str]]:
    """The design with a copy of the regional components in each secondary region."""
    regional = {"entry", "api", "worker", "cache", "database", "queue", "storage"}
    updates = [
        ComponentUpdate(id=c.id, configuration={"region": primary})
        for c in ctx.arch.components
        if ctx.roles[c.id] in regional
    ]
    added: list[ArchitectureComponent] = []
    connections: list[ArchitectureConnection] = []
    changes = [f"Label the existing regional components with region {primary}"] if updates else []
    taken = {c.id for c in ctx.arch.components}

    for region in secondaries:
        copy_of: dict[str, str] = {}
        for c in ctx.arch.components:
            role = ctx.roles[c.id]
            if role not in regional or c.configuration.get("replica_of"):
                continue
            new_id = f"{c.id}-{region}"
            if new_id in taken:
                continue
            config = {k: v for k, v in c.configuration.items() if k != "replica_of"}
            config["region"] = region
            name = f"{c.name} ({region})"
            count = ctx.count(c)
            if role == "database":
                config = {
                    "engine": c.configuration.get("engine", "postgres"),
                    "region": region,
                    "replica_of": c.id,
                    "multi_az": c.configuration.get("multi_az", False),
                }
                name = f"{c.name} replica ({region})"
            elif mode == "active-passive" and role in {"api", "worker", "cache"}:
                for key in ("instances", "replicas", "nodes", "instance_count", "count"):
                    if key in config:
                        config[key] = max(1, math.ceil(count / 2))
                        break
                else:
                    config["instances"] = max(1, math.ceil(count / 2))
            added.append(
                ArchitectureComponent(id=new_id, name=name, type=c.type, provider=c.provider, configuration=config)
            )
            taken.add(new_id)
            copy_of[c.id] = new_id
        for conn in ctx.arch.connections:
            if conn.source in copy_of and conn.target in copy_of:
                connections.append(
                    ArchitectureConnection(source=copy_of[conn.source], target=copy_of[conn.target], label=conn.label)
                )
            elif conn.source in copy_of and ctx.roles.get(conn.target) in {"auth", "search", "other"}:
                connections.append(
                    ArchitectureConnection(source=copy_of[conn.source], target=conn.target, label=conn.label)
                )
            elif conn.target in copy_of and ctx.roles.get(conn.source) == "cdn":
                connections.append(
                    ArchitectureConnection(
                        source=conn.source, target=copy_of[conn.target], label=f"{conn.label or 'origin'} ({region})"
                    )
                )
        for original, copy in copy_of.items():
            if ctx.roles[original] in {"database", "storage"}:
                connections.append(ArchitectureConnection(source=original, target=copy, label="async replication"))
        changes.append(
            f"Add {len(copy_of)} component(s) in {region}"
            + (" at half the capacity (warm standby)" if mode == "active-passive" else " at full capacity")
        )

    if not added:
        return None, ["Nothing to copy: the design has no regional components."]
    if len(ctx.arch.components) + len(added) > MAX_COMPONENTS:
        raise ValueError(
            f"The multi-region design would have {len(ctx.arch.components) + len(added)} components; the limit is {MAX_COMPONENTS}."
        )
    patch = ArchitecturePatch(
        label="Multi-region", update_components=updates, add_components=added, add_connections=connections
    )
    return apply_patch(ctx.arch, patch), changes


def plan_multi_region(req: MultiRegionRequest) -> MultiRegionResponse:
    primary = _check(req.primary_region)
    secondaries = [r for r in dict.fromkeys(_check(r) for r in req.secondary_regions) if r != primary]
    for row in req.user_regions:
        _check(row.region)
    ctx = build_context(req.architecture, req.requirements)

    deployed = [primary, *secondaries]
    serving = deployed if req.mode == "active-active" else [primary]
    involved = list(dict.fromkeys([*deployed, *(u.region for u in req.user_regions)]))
    matrix = {a: {b: rtt_ms(a, b) for b in involved} for a in involved}

    total = sum(u.percent for u in req.user_regions)
    rows: list[LatencyRow] = []
    before = after = None
    if req.user_regions and total > 0:
        for u in req.user_regions:
            nearest = min(serving, key=lambda r: matrix[u.region][r])
            rows.append(
                LatencyRow(
                    user_region=u.region,
                    percent=u.percent,
                    nearest_region=nearest,
                    primary_latency_ms=matrix[u.region][primary],
                    best_latency_ms=matrix[u.region][nearest],
                )
            )
        before = round(sum(r.percent * r.primary_latency_ms for r in rows) / total, 1)
        after = round(sum(r.percent * r.best_latency_ms for r in rows) / total, 1)

    links: list[ReplicationLink] = []
    for target in secondaries:
        rtt = matrix[primary][target]
        lag = round(0.5 + rtt / 1000 * 3, 2)
        if ctx.first("database"):
            links.append(
                ReplicationLink(
                    what=f"Database: {some(ctx.first('database')).name}",
                    source_region=primary,
                    target_region=target,
                    mode="asynchronous",
                    lag_seconds=lag,
                    note="The replica trails the primary by about this much, so a failover can lose that many seconds of writes (the RPO)."
                    + (
                        " Active-active needs a plan for writes in both regions: send writes to one region, or accept conflicts."
                        if req.mode == "active-active"
                        else ""
                    ),
                )
            )
        if ctx.first("storage"):
            links.append(
                ReplicationLink(
                    what=f"Files: {some(ctx.first('storage')).name}",
                    source_region=primary,
                    target_region=target,
                    mode="asynchronous",
                    lag_seconds=900.0,
                    note="Object storage replication usually completes within about 15 minutes.",
                )
            )
        if ctx.first("cache"):
            links.append(
                ReplicationLink(
                    what="Cache",
                    source_region=primary,
                    target_region=target,
                    mode="not replicated",
                    lag_seconds=0.0,
                    note="Each region has its own cache; after a failover it starts cold and the database takes extra load until it warms.",
                )
            )
        if ctx.first("queue"):
            links.append(
                ReplicationLink(
                    what="Queue",
                    source_region=primary,
                    target_region=target,
                    mode="not replicated",
                    lag_seconds=0.0,
                    note="Messages waiting in a failed region wait with it; design handlers so work can be re-submitted safely.",
                )
            )

    failover = [
        "Detect: health checks on each region's entry point, checked every 10 to 30 seconds from several places.",
        "Route: DNS failover or latency-based routing (for example Route 53) with a short time-to-live (about 60 seconds) sends users to a healthy region.",
    ]
    if req.mode == "active-passive":
        failover += [
            "Decide: promote the standby region only when the primary is really down, as it is a one-way step: the old primary must not accept writes again.",
            "Promote: make the replica database writable, scale the standby application servers up to full size, and switch DNS.",
            "Fail back: once the primary is healthy, copy the missed data back, then move traffic over a quiet period.",
        ]
    else:
        failover += [
            "Each region already serves traffic, so losing one means the others absorb its users: size every region to carry the whole load, or accept degraded service.",
            "Keep one region as the write leader (or use a database built for multi-region writes) and promote another if it fails.",
        ]
    failover.append("Rehearse the failover regularly: an untested plan fails when it is needed.")

    changes: list[str] = []
    variant = None
    if secondaries:
        variant, changes = _replicate(ctx, primary, secondaries, req.mode)
    else:
        changes = ["Pick at least one secondary region to build a multi-region variant."]

    notes = [
        "Latency is estimated from distance: round trip = 2 x distance x 1.5 / 200 km per ms + 3 ms. Same-region traffic is about 2 ms.",
        "Multi-region roughly doubles infrastructure cost for active-active, and adds 50% or more for a warm standby, plus data-transfer charges between regions. Compare the variant to see the cost.",
        "Most designs do not need more than two or three availability zones in one region until the availability target is very high or users are far from one region.",
    ]
    if req.mode == "active-passive" and req.user_regions:
        notes.append(
            "In active-passive mode only the primary serves users, so latency does not improve; choose active-active for that."
        )
    return MultiRegionResponse(
        regions=region_list(),
        latency_matrix=matrix,
        latency_rows=rows,
        average_latency_before_ms=before,
        average_latency_after_ms=after,
        links=links,
        failover=failover,
        changes=changes,
        architecture=variant,
        notes=notes,
    )
