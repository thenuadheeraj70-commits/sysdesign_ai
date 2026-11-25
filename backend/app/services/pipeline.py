"""Connected pipeline: architecture (+ requirements) -> performance, cost, recommendations.

Nothing here asks the user to re-type what the architecture already says. Component
counts become server counts and cost quantities, extracted traffic becomes request
rate, and the results feed the recommendation engine. Every default that had to be
assumed is returned in `derived`, so the numbers stay explainable.
"""

from app.schemas.models import (
    AnalysisInputs,
    AnalysisResponse,
    AnalysisSnapshot,
    AnalyzeRequest,
    ArchitectureComponent,
    ArchitecturePatch,
    ComponentUpdate,
    CostComponent,
    CostDiscounts,
    CostLineItem,
    CostResponse,
    FixPreview,
    OptimizationResult,
    PreviewFixRequest,
    SimulationResponse,
    TrafficProfile,
)
from app.services.cost_estimator import DEFAULT_PRICING, estimate_cost
from app.services.patch import apply_patch
from app.services.performance_analyzer import simulate_performance
from app.services.recommendation_engine import _count_key, analyze_architecture, instance_count, web_facing_ids
from app.services.terraform_generator import categorise

DEFAULT_CAPACITY_PER_SERVER = 500.0  # requests/second one server handles
DEFAULT_LATENCY_MS = 150.0
DEFAULT_PEAK_RPS = 100.0
DEFAULT_STORAGE_GB = 100.0
# Traffic model used when only a user count is known.
ACTIVE_USER_FRACTION = 0.2  # share of users active per day
REQUESTS_PER_ACTIVE_USER_PER_DAY = 50
PEAK_TO_AVERAGE = 10  # peak traffic vs. the daily average
COMPUTE_TYPES = {"compute", "container"}
# Reserved instances / savings plans apply to these steady, always-on costs.
DISCOUNTABLE_TYPES = {"compute", "container", "database", "cache", "search"}
STORAGE_KEYS = ["storage_gb", "size_gb", "capacity_gb", "allocated_storage", "storage"]


def _norm(text: str) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in text.lower()).strip("_")


def resource_type(c: ArchitectureComponent) -> str | None:
    """Which price-table entry applies to this component (None = cannot be priced)."""
    t = _norm(c.type)
    if t in DEFAULT_PRICING:
        return t
    category = categorise(c)
    return category if category in DEFAULT_PRICING else None


def quantity(c: ArchitectureComponent, rtype: str) -> float:
    if rtype == "storage":
        config = {str(k).lower(): v for k, v in c.configuration.items()}
        for key in STORAGE_KEYS:
            try:
                value = float(config[key])
            except (KeyError, TypeError, ValueError):
                continue
            if value > 0:
                return value
        return DEFAULT_STORAGE_GB
    n = instance_count(c)
    return float(max(1, round(n))) if n else 1.0


def traffic_from_users(users: float, profile: TrafficProfile | None = None) -> float:
    """Peak requests per second for a user count, using the traffic profile's peak-to-average ratio."""
    peak_to_average = profile.peak_to_average if profile else PEAK_TO_AVERAGE
    average = users * ACTIVE_USER_FRACTION * REQUESTS_PER_ACTIVE_USER_PER_DAY / 86400
    return max(1.0, round(average * peak_to_average, 2))


def users_per_rps(profile: TrafficProfile | None = None) -> float:
    """How many users one request per second of peak traffic corresponds to (the reverse of the above)."""
    peak_to_average = profile.peak_to_average if profile else PEAK_TO_AVERAGE
    return 86400 / (ACTIVE_USER_FRACTION * REQUESTS_PER_ACTIVE_USER_PER_DAY * peak_to_average)


def discount_percent(rtype: str, is_background: bool, discounts: CostDiscounts) -> float:
    """The overall discount on a cost line: a commitment on steady costs, and spot prices for the share of
    background workers that can be interrupted. Web servers never run on spot."""
    if rtype not in DISCOUNTABLE_TYPES:
        return 0.0
    commit = discounts.commitment_percent / 100
    if rtype in COMPUTE_TYPES and is_background and discounts.spot_share_percent > 0:
        share, spot = discounts.spot_share_percent / 100, discounts.spot_discount_percent / 100
        return round((1 - ((1 - share) * (1 - commit) + share * (1 - spot))) * 100, 2)
    return round(commit * 100, 2)


def build_cost_response(
    items: list[CostComponent], monthly_budget: float, discounts: dict[str, float] | None = None
) -> CostResponse:
    """Price the items. `discounts` maps item id -> percent off that line (already in the item prices)."""
    discounts = discounts or {}
    estimate = estimate_cost(
        resources=[
            {
                "resource_type": c.resource_type,
                "quantity": c.quantity,
                "unit_monthly_price": c.estimated_unit_monthly_price,
            }
            for c in items
        ],
        monthly_budget=monthly_budget,
    )
    breakdown = [
        CostLineItem(
            id=src.id,
            name=src.name or src.id,
            resource_type=line.resource_type,
            unit=line.unit,
            quantity=line.quantity,
            estimated_unit_monthly_price=line.unit_monthly_price,
            price_source=line.price_source,
            monthly_cost=line.monthly_cost,
            share_of_total_percentage=line.share_of_total_percentage,
            discount_percent=discounts.get(src.id, 0.0),
        )
        for src, line in zip(items, estimate.resources, strict=True)
    ]
    explanation = list(estimate.explanation)
    savings = 0.0
    # The estimator writes one explanation line per item, in order, followed by the totals.
    for index, (src, line, item) in enumerate(zip(items, estimate.resources, breakdown, strict=True)):
        off = discounts.get(src.id, 0.0)
        if off:
            list_price = DEFAULT_PRICING[src.resource_type]["monthly_price"]
            savings += list_price * line.quantity - line.monthly_cost
            item.price_source = f"pricing table, {off:g}% off"
            explanation[index] = explanation[index].replace("(custom price)", f"(list price minus {off:g}%)")
    savings = round(savings, 2)
    if savings > 0:
        explanation.insert(len(items), f"Discounts lower the total by {savings:,.2f} compared with list prices.")
    return CostResponse(
        is_estimate=estimate.is_estimate,
        notice=estimate.notice,
        currency=estimate.currency,
        breakdown=breakdown,
        total_monthly_cost=estimate.total_monthly_cost,
        monthly_budget=estimate.monthly_budget,
        budget_difference=estimate.budget_difference,
        budget_status=estimate.budget_status,
        explanation=explanation,
        discount_savings=savings,
    )


REDUCIBLE_TYPES = {"compute", "container", "cache", "search"}  # costs that scale with a count we can lower


def _budget_fix(arch, items: list[CostComponent], cost: CostResponse, budget: float) -> ArchitecturePatch | None:
    """Lower instance counts, most expensive unit first, until the estimate fits the budget.

    Only components with more than one instance are touched. This can raise utilization, so the
    label says so, and the analysis is re-run after the fix is applied.
    """
    by_id = {c.id: c for c in arch.components}
    kind = {i.id: i.resource_type for i in items}
    quantity_now = {line.id: int(line.quantity) for line in cost.breakdown}
    unit_price = {line.id: line.estimated_unit_monthly_price for line in cost.breakdown}
    total, changed = cost.total_monthly_cost, set()

    while total > budget:
        candidates = [i for i, q in quantity_now.items() if kind.get(i) in REDUCIBLE_TYPES and q > 1]
        if not candidates:
            break
        pick = max(candidates, key=lambda i: unit_price[i])
        quantity_now[pick] -= 1
        total = round(total - unit_price[pick], 2)
        changed.add(pick)

    if not changed:
        return None
    saved = cost.total_monthly_cost - total
    label = f"Reduce instance counts to save about ${saved:,.0f}/month (this can raise utilization)"
    if total > budget:
        label += f"; still ${total - budget:,.0f} over budget"
    return ArchitecturePatch(
        label=label,
        update_components=[
            ComponentUpdate(id=i, configuration={_count_key(by_id[i]): quantity_now[i]}) for i in sorted(changed)
        ],
    )


def _snapshot(arch, analysis: AnalysisResponse) -> AnalysisSnapshot:
    return AnalysisSnapshot(
        component_count=len(arch.components),
        number_of_servers=analysis.inputs.number_of_servers,
        utilization_percentage=analysis.performance.utilization_percentage,
        total_monthly_cost=analysis.cost.total_monthly_cost,
        budget_status=analysis.cost.budget_status,
        issue_count=len(analysis.optimization.recommendations),
    )


def preview_fix(req: PreviewFixRequest) -> FixPreview:
    """The headline numbers before and after applying a fix, using the same assumptions for both."""
    settings = dict(
        requirements=req.requirements,
        capacity_per_server=req.capacity_per_server,
        average_latency=req.average_latency,
        traffic_scale=req.traffic_scale,
    )
    patched = apply_patch(req.architecture, req.patch)
    return FixPreview(
        before=_snapshot(req.architecture, run_analysis(AnalyzeRequest(architecture=req.architecture, **settings))),
        after=_snapshot(patched, run_analysis(AnalyzeRequest(architecture=patched, **settings))),
    )


def run_analysis(req: AnalyzeRequest) -> AnalysisResponse:
    arch, reqs = req.architecture, req.requirements
    if not arch.components:
        raise ValueError("The architecture has no components to analyze")
    derived: list[str] = []

    # ---- cost items and server count come straight from the architecture ----
    items: list[CostComponent] = []
    servers = 0
    workers = 0
    unpriced: list[str] = []
    serving = web_facing_ids(arch)  # background workers are paid for but do not take user traffic
    off_by_id: dict[str, float] = {}
    for c in arch.components:
        rtype = resource_type(c)
        if rtype is None:
            unpriced.append(c.name)
            continue
        q = quantity(c, rtype)
        off = discount_percent(rtype, rtype in COMPUTE_TYPES and c.id not in serving, reqs.discounts)
        if off:
            off_by_id[c.id] = off
        items.append(
            CostComponent(
                id=c.id,
                name=c.name,
                resource_type=rtype,
                quantity=q,
                estimated_unit_monthly_price=(
                    round(DEFAULT_PRICING[rtype]["monthly_price"] * (1 - off / 100), 4) if off else None
                ),
            )
        )
        if rtype in COMPUTE_TYPES:
            if c.id in serving:
                servers += int(q)
            else:
                workers += int(q)
    if not items:
        raise ValueError("None of the components could be priced")
    if unpriced:
        derived.append("Not priced (no matching price entry): " + ", ".join(unpriced) + ".")
    derived.append(
        "Quantities come from each component's configuration (instances, replicas, "
        "storage_gb); when absent, 1 instance or 100 GB is assumed."
    )

    # ---- traffic ----
    if reqs.peak_requests_per_second is not None:
        rps = reqs.peak_requests_per_second
    elif reqs.expected_users is not None:
        rps = traffic_from_users(reqs.expected_users, reqs.traffic_profile)
        derived.append(
            f"Peak traffic of {rps:g} req/s estimated from {reqs.expected_users:,.0f} users "
            f"({ACTIVE_USER_FRACTION:.0%} active daily, {REQUESTS_PER_ACTIVE_USER_PER_DAY} requests each, "
            f"peak = {reqs.traffic_profile.peak_to_average:g}x the daily average)."
        )
    else:
        rps = DEFAULT_PEAK_RPS
        derived.append(f"No traffic or user count given, so {rps:g} req/s was assumed.")
    if req.traffic_scale != 1:
        rps = round(rps * req.traffic_scale, 4)
        derived.append(f"This design serves {req.traffic_scale:g}x of the peak traffic ({rps:g} req/s).")
    surge = reqs.traffic_profile.surge_multiplier
    effective_rps = rps * surge
    if surge > 1:
        derived.append(f"Servers are sized for surges of {surge:g}x the peak, which is {effective_rps:g} req/s.")

    if servers < 1:
        servers = 1
        derived.append("No compute component found, so 1 server was assumed for the performance model.")
    else:
        note = f"{servers} web-facing server(s) counted from the compute/container components."
        if workers:
            note += f" {workers} background worker instance(s) are priced but not counted for traffic."
        derived.append(note)

    capacity = req.capacity_per_server
    if capacity is None:
        capacity = DEFAULT_CAPACITY_PER_SERVER
        derived.append(f"Capacity per server assumed to be {capacity:g} req/s.")
    latency = req.average_latency
    if latency is None:
        latency = DEFAULT_LATENCY_MS
        derived.append(f"Average latency assumed to be {latency:g} ms.")

    sim = simulate_performance(effective_rps, servers, capacity, latency)

    budget = reqs.monthly_budget
    cost = build_cost_response(items, budget if budget is not None else 0.0, off_by_id)
    if budget is None:
        # No budget given: report the total without claiming it is over/under anything.
        cost = cost.model_copy(
            update={
                "monthly_budget": cost.total_monthly_cost,
                "budget_difference": 0.0,
                "budget_status": "Within budget",
            }
        )
        derived.append("No monthly budget given, so the budget comparison is not meaningful.")

    optimization = analyze_architecture(
        arch, sim.utilization_percentage, cost.total_monthly_cost if budget is not None else None, budget
    )
    if budget is not None and cost.total_monthly_cost > budget:
        for rec in optimization.recommendations:
            if rec.id == "over-budget":
                rec.fix = _budget_fix(arch, items, cost, budget)

    return AnalysisResponse(
        inputs=AnalysisInputs(
            peak_requests_per_second=rps,
            number_of_servers=servers,
            capacity_per_server=capacity,
            average_latency=latency,
            monthly_budget=budget,
            effective_requests_per_second=effective_rps,
        ),
        derived=derived,
        performance=SimulationResponse.model_validate(sim.model_dump()),
        cost=cost,
        optimization=OptimizationResult.model_validate(optimization.model_dump()),
    )
