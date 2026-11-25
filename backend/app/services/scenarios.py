"""Planning tools built on the connected analysis.

    compare_variants   side-by-side numbers for several designs, ranked by cost and resilience
    build_preset       turn the current design into a Cheap / Balanced / Highly available / dev / staging /
                       production variant using simple, explainable rules
    what_if            how utilization, servers and cost change as traffic changes
    grow               month by month projection of traffic growth, and when each tier must scale
    advise_budget      the cheapest changes that bring the design under a budget, safest first

Everything is an estimate from the same simple model as the Analysis panel (see performance_analyzer and
cost_estimator). Each tool says which assumptions it made, so the numbers can be checked and changed.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field

from app.schemas.models import (
    AnalysisResponse,
    AnalyzeRequest,
    ArchitectureComponent,
    ArchitectureConnection,
    ArchitecturePatch,
    ArchitectureResult,
    ComponentUpdate,
)
from app.schemas.scenarios import (
    AdvisorRequest,
    AdvisorResponse,
    AdvisorStep,
    CompareRequest,
    CompareResponse,
    GrowthMonth,
    GrowthRequest,
    GrowthResponse,
    GrowthTier,
    GrowthTierMonth,
    IssueCounts,
    PresetRequest,
    PresetResponse,
    Settings,
    VariantMetrics,
    WhatIfPoint,
    WhatIfRequest,
    WhatIfResponse,
)
from app.services.cost_estimator import DEFAULT_PRICING
from app.services.patch import apply_patch, free_id
from app.services.performance_analyzer import (
    HIGH_UTILIZATION_ABOVE,
    LOW_UTILIZATION_BELOW,
    TARGET_UTILIZATION,
    simulate_performance,
)
from app.services.pipeline import run_analysis, users_per_rps
from app.services.recommendation_engine import View, _count_key, instance_count, is_background, web_facing

# Assumed capacity of the tiers behind the web servers (requests per second one instance handles).
# These are deliberately round, documented numbers: the model is for planning, not benchmarking.
DB_CAPACITY_PER_INSTANCE = 1000.0
CACHE_CAPACITY_PER_NODE = 20000.0

SEVERITY_PENALTY = {"critical": 30, "high": 15, "medium": 7, "low": 2}
SPOF_RULES = {"single-database", "single-point-of-failure"}
OPTIONAL_TYPES = {"monitoring", "cdn", "search"}  # the advisor may suggest dropping these, as a last resort
MAX_ADVISOR_STEPS = 60


def _analyze(architecture: ArchitectureResult, settings: Settings, scale: float | None = None) -> AnalysisResponse:
    """Analyze with the shared settings. `scale` overrides the settings' own traffic share (compare and presets)."""
    return run_analysis(
        AnalyzeRequest(
            architecture=architecture,
            requirements=settings.requirements,
            capacity_per_server=settings.capacity_per_server,
            average_latency=settings.average_latency,
            traffic_scale=settings.traffic_scale if scale is None else scale,
        )
    )


def _count(component: ArchitectureComponent) -> int:
    return max(1, round(instance_count(component) or 1))


def _web_server_price(analysis: AnalysisResponse, web_ids: set[str]) -> float:
    for line in analysis.cost.breakdown:
        if line.id in web_ids:
            return line.estimated_unit_monthly_price
    return float(DEFAULT_PRICING["compute"]["monthly_price"])


def _unit_price(analysis: AnalysisResponse, ids: set[str], table_type: str) -> float:
    for line in analysis.cost.breakdown:
        if line.id in ids:
            return line.estimated_unit_monthly_price
    return float(DEFAULT_PRICING[table_type]["monthly_price"])


# ======================================================================
# Compare
# ======================================================================


def _resilience(issues: IssueCounts) -> int:
    return max(0, 100 - sum(penalty * getattr(issues, severity) for severity, penalty in SEVERITY_PENALTY.items()))


def compare_variants(req: CompareRequest) -> CompareResponse:
    rows: list[VariantMetrics] = []
    for variant in req.variants:
        try:
            a = _analyze(variant.architecture, req, variant.traffic_scale)
        except ValueError as exc:
            rows.append(VariantMetrics(id=variant.id, name=variant.name, error=str(exc)))
            continue
        counts = Counter(r.severity for r in a.optimization.recommendations)
        issues = IssueCounts(**{severity: counts.get(severity, 0) for severity in SEVERITY_PENALTY})
        weak_spots = {
            cid for r in a.optimization.recommendations if r.id in SPOF_RULES for cid in r.affected_components
        }
        rows.append(
            VariantMetrics(
                id=variant.id,
                name=variant.name,
                component_count=len(variant.architecture.components),
                number_of_servers=a.inputs.number_of_servers,
                requests_per_second=a.inputs.effective_requests_per_second or a.inputs.peak_requests_per_second,
                utilization_percentage=a.performance.utilization_percentage,
                status=a.performance.estimated_status,
                bottleneck=a.performance.bottleneck,
                monthly_cost=a.cost.total_monthly_cost,
                budget_status=a.cost.budget_status if req.requirements.monthly_budget is not None else "",
                discount_savings=a.cost.discount_savings,
                issues=issues,
                single_points_of_failure=len(weak_spots),
                resilience_score=_resilience(issues),
            )
        )

    ok = [r for r in rows if not r.error]
    for rank, row in enumerate(sorted(ok, key=lambda r: (r.monthly_cost, r.name)), start=1):
        row.cost_rank = rank
    for rank, row in enumerate(sorted(ok, key=lambda r: (-r.resilience_score, r.monthly_cost)), start=1):
        row.resilience_rank = rank

    notes: list[str] = []
    if any(abs(v.traffic_scale - 1) > 1e-9 for v in req.variants):
        notes.append(
            "Variants with a traffic share other than 100% (such as dev and staging) are analyzed against "
            "that share of the peak traffic, so their numbers are not directly comparable with production."
        )
    if len(req.variants) == 1:
        notes.append("Add a second variant to compare designs.")

    recommended, why = _recommend(ok, req.requirements.monthly_budget)
    return CompareResponse(
        variants=rows, recommended_id=recommended.id if recommended else None, recommendation=why, notes=notes
    )


def _recommend(rows: list[VariantMetrics], budget: float | None) -> tuple[VariantMetrics | None, str]:
    """The most resilient design that fits the budget; with no budget, the most resilient one that costs no
    more than 25% above the cheapest (resilience bought at any price is not a recommendation)."""
    if not rows:
        return None, "None of the variants could be analyzed."
    cheapest = min(rows, key=lambda r: r.monthly_cost)
    if budget is not None:
        fits = [r for r in rows if r.monthly_cost <= budget]
        if not fits:
            return cheapest, (
                f"No variant fits the ${budget:,.0f} budget. {cheapest.name} is the cheapest at "
                f"${cheapest.monthly_cost:,.0f}."
            )
        best = max(fits, key=lambda r: (r.resilience_score, -r.monthly_cost))
        return best, (
            f"{best.name} is the most resilient design within the ${budget:,.0f} budget "
            f"(resilience {best.resilience_score}/100, ${best.monthly_cost:,.0f} per month)."
        )
    value = [r for r in rows if r.monthly_cost <= cheapest.monthly_cost * 1.25]
    best = max(value, key=lambda r: (r.resilience_score, -r.monthly_cost))
    return best, (
        f"{best.name} gives the best resilience (score {best.resilience_score}/100) for a cost within 25% of the "
        f"cheapest option (${best.monthly_cost:,.0f} per month). Set a budget for a more specific answer."
    )


# ======================================================================
# Presets
# ======================================================================


@dataclass(frozen=True)
class Preset:
    name: str
    description: str
    target_utilization: float | None  # None: halve or minimise counts instead of sizing for traffic
    min_web: int
    worker_min: int | None = None  # at least this many background workers (None: leave them)
    workers_to_one: bool = False
    cache_nodes: int | None = None  # set cache nodes to exactly this (None: leave)
    cache_min: int | None = None
    multi_az: bool = False
    read_replicas: int = 0
    high_availability: bool = False
    add_load_balancer: bool = False
    add_cache: bool = False
    halve: bool = False  # staging: half of every count
    all_to_one: bool = False  # dev: one of everything
    traffic_scale: float = 1.0


PRESETS: dict[str, Preset] = {
    "cheap": Preset(
        "Cheap",
        "Just enough servers for about 85% utilization at peak, a single cache node, and a single-zone database. "
        "Lowest cost, least headroom and no redundancy.",
        target_utilization=0.85,
        min_web=1,
        workers_to_one=True,
        cache_nodes=1,
    ),
    "balanced": Preset(
        "Balanced",
        "Web servers sized for about 65% utilization (at least two), a multi-zone database, at least two cache "
        "nodes, and a load balancer in front.",
        target_utilization=0.65,
        min_web=2,
        cache_min=2,
        multi_az=True,
        add_load_balancer=True,
    ),
    "highly_available": Preset(
        "Highly available",
        "Web servers sized for about 50% utilization (at least three), two of every background worker, a "
        "multi-zone database with a read replica, a cache, a load balancer, and high availability on every other "
        "service.",
        target_utilization=0.5,
        min_web=3,
        worker_min=2,
        cache_min=2,
        multi_az=True,
        read_replicas=1,
        high_availability=True,
        add_load_balancer=True,
        add_cache=True,
    ),
    "dev": Preset(
        "Development",
        "One of everything and no redundancy, serving about 2% of the production traffic. For building and trying "
        "things out.",
        target_utilization=None,
        min_web=1,
        all_to_one=True,
        traffic_scale=0.02,
    ),
    "staging": Preset(
        "Staging",
        "Half the instances of every service and no redundancy, serving about 25% of the production traffic. "
        "For testing releases under realistic load.",
        target_utilization=None,
        min_web=1,
        halve=True,
        traffic_scale=0.25,
    ),
    "production": Preset(
        "Production",
        "A production-grade version of this design: web servers sized for about 65% utilization (at least two), "
        "multi-zone database, at least two cache nodes, and a load balancer.",
        target_utilization=0.65,
        min_web=2,
        cache_min=2,
        multi_az=True,
        add_load_balancer=True,
    ),
}


def build_preset(req: PresetRequest) -> PresetResponse:
    preset = PRESETS[req.kind]
    arch = req.architecture
    base = _analyze(arch, req, 1.0)  # presets size for the full production traffic
    traffic = base.inputs.effective_requests_per_second or base.inputs.peak_requests_per_second
    capacity = base.inputs.capacity_per_server

    view = View(arch)
    web = {c.id for c in web_facing(view)}
    updates: list[ComponentUpdate] = []
    changes: list[str] = []

    def set_count(c: ArchitectureComponent, target: int, noun: str = "instances") -> None:
        current = _count(c)
        if target != current:
            updates.append(ComponentUpdate(id=c.id, configuration={_count_key(c): target}))
            changes.append(f"{c.name}: {current} → {target} {noun}")

    def set_flags(c: ArchitectureComponent, flags: dict, what: str) -> None:
        differing = {k: v for k, v in flags.items() if c.configuration.get(k) != v}
        if differing:
            updates.append(ComponentUpdate(id=c.id, configuration=differing))
            changes.append(f"{c.name}: {what}")

    for c in arch.components:
        category = view.category[c.id]
        if category == "compute":
            if preset.all_to_one:
                target = 1
            elif preset.halve:
                target = max(1, math.ceil(_count(c) / 2))
            elif c.id in web:
                target = max(preset.min_web, math.ceil(traffic / (capacity * (preset.target_utilization or 1))))
            else:  # background worker
                target = 1 if preset.workers_to_one else max(_count(c), preset.worker_min or 1)
            set_count(c, target)
        elif category == "cache":
            if preset.all_to_one:
                target = 1
            elif preset.halve:
                target = max(1, math.ceil(_count(c) / 2))
            elif preset.cache_nodes is not None:
                target = preset.cache_nodes
            else:
                target = max(_count(c), preset.cache_min or 1)
            set_count(c, target, "nodes")
        elif category == "database":
            wanted_az = preset.multi_az
            flags: dict[str, object] = {"multi_az": wanted_az}
            if preset.read_replicas or c.configuration.get("read_replicas"):
                flags["read_replicas"] = preset.read_replicas
            set_flags(
                c,
                flags,
                ("multi-zone" if wanted_az else "single zone")
                + (f" with {preset.read_replicas} read replica" if preset.read_replicas else ""),
            )
        elif category == "load_balancer" and preset.high_availability:
            set_flags(c, {"multi_az": True}, "spread across zones")
        elif category == "other" and preset.high_availability:
            set_flags(c, {"high_availability": True}, "high availability on")

    add_components: list[ArchitectureComponent] = []
    add_connections: list[ArchitectureConnection] = []
    taken = {c.id for c in arch.components}
    web_components = [c for c in arch.components if c.id in web]
    provider = (
        web_components[0].provider if web_components else (arch.components[0].provider if arch.components else "aws")
    )

    if preset.add_load_balancer and web_components and not view.of("load_balancer"):
        lb_id = free_id("load-balancer", taken)
        taken.add(lb_id)
        add_components.append(
            ArchitectureComponent(id=lb_id, name="Load Balancer", type="load_balancer", provider=provider)
        )
        add_connections += [ArchitectureConnection(source=lb_id, target=c.id, label="HTTP") for c in web_components]
        changes.append("Add a load balancer in front of the web servers")
    if preset.add_cache and web_components and view.of("database") and not view.of("cache"):
        cache_id = free_id("cache", taken)
        taken.add(cache_id)
        add_components.append(
            ArchitectureComponent(
                id=cache_id,
                name="Cache",
                type="cache",
                provider=provider,
                configuration={"engine": "redis", "nodes": 2},
            )
        )
        add_connections += [
            ArchitectureConnection(source=c.id, target=cache_id, label="cached reads") for c in web_components
        ]
        changes.append("Add a 2-node Redis cache")

    patch = ArchitecturePatch(
        label=f"Make this a {preset.name} design",
        update_components=updates,
        add_components=add_components,
        add_connections=add_connections,
    )
    result = apply_patch(arch, patch)
    if preset.traffic_scale != 1:
        changes.append(f"Serves {preset.traffic_scale:.0%} of the production traffic")
    if not changes:
        changes.append("No changes needed: this design already matches the preset.")
    return PresetResponse(
        kind=req.kind,
        name=preset.name,
        description=preset.description,
        architecture=result,
        traffic_scale=preset.traffic_scale,
        changes=changes,
    )


# ======================================================================
# What-if
# ======================================================================

DEFAULT_MULTIPLES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10]


def what_if(req: WhatIfRequest) -> WhatIfResponse:
    a = _analyze(req.architecture, req)
    base_rps = a.inputs.effective_requests_per_second or a.inputs.peak_requests_per_second
    servers, capacity = a.inputs.number_of_servers, a.inputs.capacity_per_server
    web_ids = {c.id for c in web_facing(View(req.architecture))}
    price = _web_server_price(a, web_ids)
    factor = users_per_rps(req.requirements.traffic_profile)

    values = req.rps_values if req.rps_values is not None else [round(base_rps * m, 2) for m in DEFAULT_MULTIPLES]
    if any(v < 0 or v > 1e12 for v in values):
        raise ValueError("Traffic values must be between 0 and 1,000,000,000,000 requests per second")

    points = []
    for rps in values:
        sim = simulate_performance(rps, servers, capacity, a.inputs.average_latency)
        needed = max(1, math.ceil(rps / (capacity * TARGET_UTILIZATION / 100)))
        points.append(
            WhatIfPoint(
                requests_per_second=rps,
                users_equivalent=round(rps * factor),
                utilization_percentage=sim.utilization_percentage,
                status=sim.estimated_status,
                bottleneck=sim.bottleneck,
                servers_needed=needed,
                monthly_cost_if_scaled=round(a.cost.total_monthly_cost + max(0, needed - servers) * price, 2),
            )
        )

    total_capacity = servers * capacity
    return WhatIfResponse(
        base_requests_per_second=base_rps,
        number_of_servers=servers,
        capacity_per_server=capacity,
        capacity_requests_per_second=total_capacity,
        comfortable_requests_per_second=total_capacity * HIGH_UTILIZATION_ABOVE / 100,
        target_utilization=TARGET_UTILIZATION,
        low_utilization_below=LOW_UTILIZATION_BELOW,
        high_utilization_above=HIGH_UTILIZATION_ABOVE,
        base_monthly_cost=a.cost.total_monthly_cost,
        server_monthly_price=price,
        points=points,
        notes=[
            f"Capacity is {servers} server(s) x {capacity:g} req/s = {total_capacity:g} req/s. Utilization reaches "
            f"100% there, and passes the {HIGH_UTILIZATION_ABOVE:g}% 'high' line at {total_capacity * HIGH_UTILIZATION_ABOVE / 100:g} req/s.",
            f"'Servers needed' keeps utilization at or under {TARGET_UTILIZATION:g}%; the scaled cost adds those "
            f"servers at {price:,.2f} each.",
            "The user figures are rough: they reverse the traffic model (share of users active, requests per user, "
            "peak-to-average ratio) used to estimate traffic from a user count.",
        ],
    )


# ======================================================================
# Growth
# ======================================================================


def grow(req: GrowthRequest) -> GrowthResponse:
    a = _analyze(req.architecture, req)
    base_rps = a.inputs.effective_requests_per_second or a.inputs.peak_requests_per_second
    capacity = a.inputs.capacity_per_server
    view = View(req.architecture)
    profile = req.requirements.traffic_profile

    web_ids = {c.id for c in web_facing(view)}
    db_comps, cache_comps = view.of("database"), view.of("cache")
    db_instances = sum(_count(c) + int(c.configuration.get("read_replicas") or 0) for c in db_comps)
    cache_nodes = sum(_count(c) for c in cache_comps)

    # What share of the request rate each tier sees.
    db_factor = (profile.read_ratio * (1 - profile.cache_hit_ratio) + (1 - profile.read_ratio)) if cache_nodes else 1.0
    tiers_spec = [
        (
            "web",
            "Web servers",
            a.inputs.number_of_servers,
            capacity,
            1.0,
            _web_server_price(a, web_ids),
            f"Each server handles {capacity:g} req/s (the capacity per server above).",
        )
    ]
    if db_instances:
        tiers_spec.append(
            (
                "database",
                "Database",
                db_instances,
                DB_CAPACITY_PER_INSTANCE,
                db_factor,
                _unit_price(a, {c.id for c in db_comps}, "database"),
                f"Each database instance handles {DB_CAPACITY_PER_INSTANCE:g} req/s. It sees {db_factor:.0%} of the traffic "
                + (
                    "(cache misses and all writes)."
                    if cache_nodes
                    else "(there is no cache, so every request reaches it)."
                ),
            )
        )
    if cache_nodes:
        tiers_spec.append(
            (
                "cache",
                "Cache",
                cache_nodes,
                CACHE_CAPACITY_PER_NODE,
                profile.read_ratio,
                _unit_price(a, {c.id for c in cache_comps}, "cache"),
                f"Each cache node handles {CACHE_CAPACITY_PER_NODE:g} req/s. It sees the reads ({profile.read_ratio:.0%} of traffic).",
            )
        )

    growth = 1 + req.monthly_growth_percent / 100
    target = TARGET_UTILIZATION / 100
    months: list[GrowthMonth] = []
    first_scale: dict[str, int | None] = {kind: None for kind, *_ in tiers_spec}

    for m in range(req.months + 1):
        rps = base_rps * growth**m
        tier_values: dict[str, GrowthTierMonth] = {}
        extra_cost = 0.0
        for kind, _name, instances, cap, factor, price, _why in tiers_spec:
            load = rps * factor
            utilization = load / (instances * cap) * 100
            needed = max(1, math.ceil(load / (cap * target)))
            tier_values[kind] = GrowthTierMonth(utilization_percentage=round(utilization, 1), instances_needed=needed)
            extra_cost += max(0, needed - instances) * price
            if first_scale[kind] is None and utilization > HIGH_UTILIZATION_ABOVE:
                first_scale[kind] = m
        months.append(
            GrowthMonth(
                month=m,
                requests_per_second=round(rps, 2),
                tiers=tier_values,
                monthly_cost_if_scaled=round(a.cost.total_monthly_cost + extra_cost, 2),
            )
        )

    tiers = [
        GrowthTier(
            kind=kind,
            name=name,
            instances=instances,
            capacity_per_instance=cap,
            assumption=why,
            first_scale_month=first_scale[kind],
        )
        for kind, name, instances, cap, _factor, _price, why in tiers_spec
    ]
    return GrowthResponse(
        months=months,
        tiers=tiers,
        base_monthly_cost=a.cost.total_monthly_cost,
        total_cost_if_scaled=round(sum(m.monthly_cost_if_scaled for m in months[1:]), 2),
        total_cost_unchanged=round(a.cost.total_monthly_cost * req.months, 2),
        target_utilization=TARGET_UTILIZATION,
        high_utilization_above=HIGH_UTILIZATION_ABOVE,
        assumptions=[
            f"Traffic grows {req.monthly_growth_percent:g}% every month, compounding, starting from "
            f"{base_rps:g} req/s today.",
            f"A tier 'needs to scale' when its utilization passes {HIGH_UTILIZATION_ABOVE:g}%. The 'instances "
            f"needed' keep it at or under {TARGET_UTILIZATION:g}%.",
            "Only compute-style costs are added as the design scales; storage growth, data transfer and price "
            "changes are not modelled.",
            "The database and cache capacities are round planning numbers, not measurements of your system.",
        ],
    )


# ======================================================================
# Budget advisor
# ======================================================================


@dataclass
class _Candidate:
    """One possible single change: lower a count by one, or remove a component."""

    patch: ArchitecturePatch
    update: ComponentUpdate | None = None  # set when a count is lowered
    name: str = ""
    old: int = 0
    new: int = 0
    noun: str = ""


@dataclass
class _Advice:
    steps: list[AdvisorStep] = field(default_factory=list)
    updates: dict[str, dict] = field(default_factory=dict)  # component id -> settings changed so far
    removed: list[str] = field(default_factory=list)
    chain: tuple[str, str, str, int, str] | None = None  # (component id, risk, name, first old count, noun)

    def cumulative(self, label: str) -> ArchitecturePatch:
        return ArchitecturePatch(
            label=label,
            update_components=[ComponentUpdate(id=i, configuration=dict(c)) for i, c in self.updates.items()],
            remove_components=list(self.removed),
        )


_RISK_NOTES = {
    "low": "Low risk: the web tier keeps comfortable headroom (about 70% utilization or less).",
    "medium": "Medium risk: less headroom, or fewer copies of a service. Check performance and failover.",
    "high": "High risk: removes a capability, or leaves the web tier almost out of capacity.",
}
# (risk, what changes, utilization ceiling the web tier must stay under)
_STAGES: list[tuple[str, str, float | None]] = [
    ("low", "web", 70.0),
    ("medium", "trim", None),
    ("medium", "web", 85.0),
    ("high", "optional", None),
    ("high", "web", 100.0),
]


def _candidates(arch: ArchitectureResult, kind: str) -> list[_Candidate]:
    view = View(arch)
    web = {c.id for c in web_facing(view)}
    out: list[_Candidate] = []

    def lower(c: ArchitectureComponent, noun: str) -> None:
        now = _count(c)
        if now > 1:
            update = ComponentUpdate(id=c.id, configuration={_count_key(c): now - 1})
            patch = ArchitecturePatch(label=f"{c.name}: {now} → {now - 1} {noun}", update_components=[update])
            out.append(_Candidate(patch, update, c.name, now, now - 1, noun))

    for c in arch.components:
        category = view.category[c.id]
        if kind == "web" and category == "compute" and c.id in web:
            lower(c, "instances")
        elif kind == "trim" and category == "compute" and c.id not in web and is_background(view, c):
            lower(c, "instances")
        elif kind == "trim" and category == "cache":
            lower(c, "nodes")
        elif kind == "optional" and c.type.lower() in OPTIONAL_TYPES:
            patch = ArchitecturePatch(label=f"Remove {c.name} ({c.type})", remove_components=[c.id])
            out.append(_Candidate(patch))
    return out


def advise_budget(req: AdvisorRequest) -> AdvisorResponse:
    start = _analyze(req.architecture, req)
    total = start.cost.total_monthly_cost
    if total <= req.budget:
        return AdvisorResponse(
            current_total=total,
            budget=req.budget,
            over_by=0.0,
            reachable=True,
            final_total=total,
            steps=[],
            notes=["The design is already within budget, so there is nothing to cut."],
        )

    advice = _Advice()
    arch, current_total, guard = req.architecture, total, 0

    for risk, kind, ceiling in _STAGES:
        advice.chain = None  # a new stage starts a new step, even for a service lowered in an earlier stage
        while current_total > req.budget and guard < MAX_ADVISOR_STEPS:
            guard += 1
            chosen: tuple[float, _Candidate, ArchitectureResult, AnalysisResponse] | None = None
            for cand in _candidates(arch, kind):
                candidate_arch = apply_patch(arch, cand.patch)
                try:
                    a = _analyze(candidate_arch, req)
                except ValueError:
                    continue
                if ceiling is not None and a.performance.utilization_percentage > ceiling:
                    continue
                saving = current_total - a.cost.total_monthly_cost
                if saving > 0 and (chosen is None or saving > chosen[0]):
                    chosen = (saving, cand, candidate_arch, a)
            if chosen is None:
                break
            saving, cand, arch, a = chosen
            current_total = a.cost.total_monthly_cost

            if cand.update is not None:
                advice.updates[cand.update.id] = {**advice.updates.get(cand.update.id, {}), **cand.update.configuration}
            else:  # a component was removed: any earlier count change for it no longer matters
                for gone in cand.patch.remove_components:
                    advice.updates.pop(gone, None)
                    advice.removed.append(gone)

            key = (cand.update.id, risk) if cand.update else None
            if advice.steps and key and cand.update is not None and advice.chain and advice.chain[:2] == key:
                # Lowering the same service again folds into the previous step: "6 → 5 → 4" becomes "6 → 4".
                _, _, name, first_old, noun = advice.chain
                previous = advice.steps[-1]
                previous.label = f"{name}: {first_old} → {cand.new} {noun}"
                previous.saving = round(previous.saving + saving, 2)
                previous.total_after = current_total
                previous.utilization_after = a.performance.utilization_percentage
                previous.patch = ArchitecturePatch(
                    label=previous.label,
                    update_components=[
                        ComponentUpdate(id=cand.update.id, configuration=dict(advice.updates[cand.update.id]))
                    ],
                )
                previous.cumulative_patch = advice.cumulative(f"Steps 1 to {len(advice.steps)}")
            else:
                advice.steps.append(
                    AdvisorStep(
                        label=cand.patch.label,
                        saving=round(saving, 2),
                        total_after=current_total,
                        utilization_after=a.performance.utilization_percentage,
                        risk=risk,
                        risk_note=_RISK_NOTES[risk],
                        patch=cand.patch,
                        cumulative_patch=advice.cumulative(f"Steps 1 to {len(advice.steps) + 1}"),
                    )
                )
                advice.chain = (cand.update.id, risk, cand.name, cand.old, cand.noun) if cand.update else None

    reachable = current_total <= req.budget
    notes = ["Savings assume the traffic stays the same. Apply the steps up to the one you are comfortable with."]
    if not reachable:
        notes.append(
            f"Even after every step the estimate is ${current_total - req.budget:,.0f} over the budget. "
            "A smaller design, cheaper services or a bigger budget is needed."
        )
    return AdvisorResponse(
        current_total=total,
        budget=req.budget,
        over_by=round(total - req.budget, 2),
        reachable=reachable,
        final_total=current_total,
        steps=advice.steps,
        notes=notes,
    )
