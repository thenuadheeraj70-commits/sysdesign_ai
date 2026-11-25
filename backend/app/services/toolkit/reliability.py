"""Reliability: how available the design is likely to be, how long recovery would take (RTO) and how much recent
data could be lost (RPO), checked against targets, with the changes that would close any gap.

The model is deliberately simple and every assumption is returned with the answer:
  * a chain of components that must all work is multiplied together (availability of the whole = product);
  * copies that can replace each other multiply the chance of failure (1 - (1 - a)^copies);
  * caches and background workers degrade the system when they fail but do not stop it, so they are off the path.
"""

from __future__ import annotations

import re

from app.schemas.models import (
    ArchitectureComponent,
    ArchitecturePatch,
    ArchitectureResult,
    ComponentUpdate,
    Requirements,
)
from app.schemas.toolkit import ReliabilityAdvice, ReliabilityComponent, ReliabilityResponse
from app.services.recommendation_engine import _load_balancer_fix
from app.services.toolkit.common import Context, build_context

MINUTES_PER_YEAR = 525_600

INSTANCE_AVAILABILITY = 99.5  # one virtual machine or container instance
MAX_USEFUL_COPIES = 3  # failures are partly correlated, so a fourth copy adds nothing in this model
MANAGED_AVAILABILITY = {"entry": 99.99, "cdn": 99.99, "auth": 99.9, "storage": 99.99, "queue": 99.9, "search": 99.9}
DB_SINGLE, DB_MULTI_AZ, DB_REPLICA = 99.5, 99.95, 99.97
DNS_FAILOVER = 99.99

# Recovery after losing one server or one availability zone, in minutes.
RTO_AUTO_REPLACE = 5  # a load balancer and autoscaling replace a failed server
RTO_SURVIVING_COPY = 1  # another copy keeps serving while the failed one is replaced
RTO_SINGLE_INSTANCE = 30  # someone restarts or rebuilds the only copy
RTO_DB_FAILOVER = 2  # multi-zone databases fail over by themselves
RTO_DB_RESTORE = 60  # restore from a backup
RPO_NIGHTLY_BACKUP = 24 * 60
RPO_POINT_IN_TIME = 5
RPO_SYNC_STANDBY = 0


def parse_target(text: str) -> float | None:
    """'99.9%' -> 99.9; 'five nines' -> 99.999; 'high availability' -> 99.9; anything else -> None."""
    lowered = text.lower()
    found = re.search(r"(\d{2}(?:\.\d+)?)\s*%?", lowered)
    if found and 90 <= float(found.group(1)) < 100:
        return float(found.group(1))
    for words, value in (("five nines", 99.999), ("four nines", 99.99), ("three nines", 99.9), ("two nines", 99.0)):
        if words in lowered:
            return value
    if "high availability" in lowered or "highly available" in lowered:
        return 99.9
    return None


def _copies(ctx: Context, c: ArchitectureComponent) -> int:
    return min(ctx.count(c), MAX_USEFUL_COPIES)


def _redundant(a: float, copies: int) -> float:
    return 100 * (1 - (1 - a / 100) ** copies)


def _regions(ctx: Context) -> set[str]:
    return {
        str(c.configuration["region"])
        for c in ctx.arch.components
        if ctx.roles[c.id] in {"api", "database"} and c.configuration.get("region")
    }


def estimate_reliability(arch: ArchitectureResult, reqs: Requirements) -> ReliabilityResponse:
    ctx = build_context(arch, reqs)
    components: list[ReliabilityComponent] = []
    chain = 1.0

    def add(c: ArchitectureComponent, availability: float, why: str, critical: bool) -> None:
        nonlocal chain
        components.append(
            ReliabilityComponent(
                id=c.id, name=c.name, availability_percent=round(availability, 4), why=why, on_critical_path=critical
            )
        )
        if critical:
            chain *= availability / 100

    replica_ids = {c.id for c in ctx.with_role("database") if c.configuration.get("replica_of")}
    primary_regions = _regions(ctx)
    for c in ctx.arch.components:
        role = ctx.roles[c.id]
        if role in {"api"}:
            copies = _copies(ctx, c)
            a = _redundant(INSTANCE_AVAILABILITY, copies)
            add(
                c,
                a,
                f"{copies} instance(s) at {INSTANCE_AVAILABILITY}% each"
                + (", so a failed one is covered by the others" if copies > 1 else ", so one failure is an outage"),
                True,
            )
        elif role == "database":
            if c.id in replica_ids:
                add(
                    c,
                    DB_REPLICA,
                    "A cross-region replica: counted in the multi-region result, not in the single-region chain",
                    False,
                )
                continue
            replicas = int(c.configuration.get("read_replicas") or 0)
            if c.configuration.get("multi_az") is True:
                a, why = (
                    (DB_REPLICA if replicas else DB_MULTI_AZ),
                    "Multi-zone with automatic failover" + (" and a read replica" if replicas else ""),
                )
            else:
                a, why = DB_SINGLE, "A single instance in one zone"
            add(c, a, why, True)
        elif role in MANAGED_AVAILABILITY:
            # Auth is only on the path if the web tier talks to it; the entry point and CDN always are.
            on_path = role in {"entry", "cdn"} or any(
                {x.source, x.target} == {c.id, w.id} for x in ctx.arch.connections for w in ctx.web
            )
            if role in {"queue", "search", "storage"}:
                add(
                    c,
                    MANAGED_AVAILABILITY[role],
                    "Managed service; only the features that use it are affected, so it is not counted against the whole system",
                    False,
                )
            else:
                add(
                    c,
                    MANAGED_AVAILABILITY[role],
                    "Managed service with built-in redundancy"
                    + ("" if on_path else " (not connected to the web tier here)"),
                    on_path,
                )
        elif role == "cache":
            add(
                c,
                _redundant(INSTANCE_AVAILABILITY, _copies(ctx, c)),
                "A cache outage makes things slower, not unavailable",
                False,
            )
        elif role == "worker":
            add(
                c,
                _redundant(INSTANCE_AVAILABILITY, _copies(ctx, c)),
                "Background work waits in the queue while workers are down",
                False,
            )

    available = chain * 100
    regions = primary_regions
    assumptions = [
        f"One server or container instance is {INSTANCE_AVAILABILITY}% available; copies replace each other, with the benefit capped at {MAX_USEFUL_COPIES} because failures are partly correlated.",
        "Managed services (load balancer, CDN, auth, queue, storage) use typical published figures: 99.9% to 99.99%.",
        f"A database is {DB_SINGLE}% available as a single instance and {DB_MULTI_AZ}% with a standby in another zone.",
        "The whole system is the product of everything a request must pass through. Caches and background workers are not on that path.",
        "These are planning figures, not guarantees: real availability depends on deployments, bugs and operations as much as on hardware.",
    ]
    if len(regions) >= 2:
        available = _redundant(available, 2) * DNS_FAILOVER / 100
        assumptions.append(
            f"The design spans {len(regions)} regions, so the result assumes either region can serve alone behind DNS failover ({DNS_FAILOVER}%)."
        )

    downtime_year = (1 - available / 100) * MINUTES_PER_YEAR
    target = reqs.reliability.availability_percent or parse_target(reqs.availability_target)

    # ---- recovery time and data loss ----
    rto, rto_reason = _recovery_time(ctx, regions)
    rpo, rpo_reason = _recovery_point(ctx, regions)

    verdicts: list[str] = []
    gap = None
    if target is not None:
        gap = round(available - target, 4)
        allowed = (1 - target / 100) * MINUTES_PER_YEAR
        if gap >= 0:
            verdicts.append(
                f"Availability: the estimate ({available:.3f}%) meets the {target}% target, with about {allowed - downtime_year:,.0f} minutes a year to spare."
            )
        else:
            verdicts.append(
                f"Availability: the estimate ({available:.3f}%) is short of the {target}% target by {abs(gap):.3f} points, about {downtime_year - allowed:,.0f} extra minutes of downtime a year."
            )
    else:
        verdicts.append("No availability target is set: add one to see whether the design meets it.")
    for label, estimate, wanted, unit in (
        ("Recovery time (RTO)", rto, reqs.reliability.rto_minutes, "minutes"),
        ("Data loss window (RPO)", rpo, reqs.reliability.rpo_minutes, "minutes"),
    ):
        if wanted is None:
            verdicts.append(f"{label}: about {estimate:g} {unit} after losing a server or a zone. No target is set.")
        elif estimate <= wanted:
            verdicts.append(f"{label}: about {estimate:g} {unit}, within the {wanted:g} {unit} target.")
        else:
            verdicts.append(f"{label}: about {estimate:g} {unit}, longer than the {wanted:g} {unit} target.")

    advice = _advice(ctx, available, target, rto, rpo, reqs, len(regions))
    return ReliabilityResponse(
        estimated_availability_percent=round(available, 4),
        downtime_minutes_per_year=round(downtime_year, 1),
        downtime_minutes_per_month=round(downtime_year / 12, 1),
        target_availability_percent=target,
        availability_gap_percent=gap,
        estimated_rto_minutes=rto,
        estimated_rpo_minutes=rpo,
        rto_reason=rto_reason,
        rpo_reason=rpo_reason,
        components=components,
        verdicts=verdicts,
        advice=advice,
        assumptions=assumptions,
    )


def _recovery_time(ctx: Context, regions: set[str]) -> tuple[float, str]:
    worst, reason = 0.0, "Nothing in the design needs manual recovery."
    for c in ctx.web:
        if ctx.count(c) >= 2:
            t, why = RTO_SURVIVING_COPY, f"{c.name} has several copies, so the others keep serving"
        elif str(c.configuration.get("autoscaling")).lower() == "true":
            t, why = RTO_AUTO_REPLACE, f"{c.name} is replaced automatically by autoscaling"
        else:
            t, why = RTO_SINGLE_INSTANCE, f"{c.name} is a single instance that someone has to restart or rebuild"
        if t > worst:
            worst, reason = t, why
    for c in ctx.with_role("database"):
        if c.configuration.get("replica_of"):
            continue
        t, why = (
            (RTO_DB_FAILOVER, f"{c.name} fails over to its standby by itself")
            if c.configuration.get("multi_az") is True
            else (RTO_DB_RESTORE, f"{c.name} is a single instance, so recovery means restoring a backup")
        )
        if t > worst:
            worst, reason = t, why
    return float(worst), reason


def _recovery_point(ctx: Context, regions: set[str]) -> tuple[float, str]:
    databases = [c for c in ctx.with_role("database") if not c.configuration.get("replica_of")]
    if not databases:
        return 0.0, "The design keeps no database, so there is no stored data to lose."
    worst, reason = 0.0, ""
    for c in databases:
        if c.configuration.get("multi_az") is True:
            t, why = (
                RPO_SYNC_STANDBY,
                f"{c.name} writes to a standby in another zone before confirming, so a zone failure loses nothing",
            )
        elif (
            c.configuration.get("backup_retention_days")
            or str(c.configuration.get("point_in_time_recovery")).lower() == "true"
        ):
            t, why = RPO_POINT_IN_TIME, f"{c.name} has point-in-time recovery: at most a few minutes are lost"
        else:
            t, why = (
                RPO_NIGHTLY_BACKUP,
                f"{c.name} is a single instance with no backup setting, so assume nightly backups: up to a day of data is lost",
            )
        if t >= worst:
            worst, reason = t, why
    return float(worst), reason


def _advice(
    ctx: Context, available: float, target: float | None, rto: float, rpo: float, reqs: Requirements, region_count: int
) -> list[ReliabilityAdvice]:
    out: list[ReliabilityAdvice] = []
    wants_more = (
        (target is not None and available < target)
        or (reqs.reliability.rto_minutes is not None and rto > reqs.reliability.rto_minutes)
        or (reqs.reliability.rpo_minutes is not None and rpo > reqs.reliability.rpo_minutes)
    )

    singles = [c for c in ctx.web if ctx.count(c) < 2]
    if singles:
        out.append(
            ReliabilityAdvice(
                title="Run at least two copies of the web servers",
                detail=f"{', '.join(c.name for c in singles)} run as a single instance: one failure is an outage. Two copies behind a load balancer survive it.",
                fix=ArchitecturePatch(
                    label="Run two copies of the web servers",
                    update_components=[ComponentUpdate(id=c.id, configuration={"instances": 2}) for c in singles],
                ),
            )
        )
    if len(ctx.web) >= 1 and not ctx.first("entry"):
        out.append(
            ReliabilityAdvice(
                title="Put a load balancer in front",
                detail="Without one there is no single front door, and nothing sends traffic away from a failed server.",
                fix=_load_balancer_fix(ctx.view),
            )
        )
    for db in ctx.with_role("database"):
        if db.configuration.get("replica_of"):
            continue
        if db.configuration.get("multi_az") is not True:
            out.append(
                ReliabilityAdvice(
                    title=f"Make {db.name} multi-zone",
                    detail="A standby in another zone takes over automatically: recovery in about two minutes and no data loss from a zone failure.",
                    fix=ArchitecturePatch(
                        label=f"Enable multi-zone on {db.name}",
                        update_components=[ComponentUpdate(id=db.id, configuration={"multi_az": True})],
                    ),
                )
            )
        if (
            not db.configuration.get("backup_retention_days")
            and db.configuration.get("multi_az") is not True
            or (not db.configuration.get("backup_retention_days") and wants_more)
        ):
            out.append(
                ReliabilityAdvice(
                    title=f"Keep backups of {db.name}",
                    detail="Redundancy does not protect against deleted or corrupted data. Keep automated backups with point-in-time recovery for at least a week, and test restoring one.",
                    fix=ArchitecturePatch(
                        label=f"Keep 7 days of backups for {db.name}",
                        update_components=[ComponentUpdate(id=db.id, configuration={"backup_retention_days": 7})],
                    ),
                )
            )
    for cache in ctx.with_role("cache"):
        if ctx.count(cache) < 2:
            out.append(
                ReliabilityAdvice(
                    title=f"{cache.name} is a single node",
                    detail="If it fails the database takes the full read load at once. Use two nodes, or make sure the database can survive that load.",
                )
            )
    if target is not None and target >= 99.95 and region_count < 2:
        out.append(
            ReliabilityAdvice(
                title="A single region may not reach this target",
                detail=f"{target}% allows only about {(1 - target / 100) * MINUTES_PER_YEAR:,.0f} minutes of downtime a year, which a regional outage alone can use up. See the multi-region tool.",
            )
        )
    if not out and not wants_more:
        out.append(
            ReliabilityAdvice(
                title="Nothing obvious to fix",
                detail="The design meets the targets that are set. Re-check after changes, and rehearse a failure to confirm the recovery figures.",
            )
        )
    return out
