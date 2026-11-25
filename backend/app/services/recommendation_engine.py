"""Rule-based architecture optimizer.

Looks at an ArchitectureResult and reports POSSIBLE problems with an explanation
and a suggested fix. Every check is a simple, readable rule.

Be aware of the limits of this approach:
  * It only sees component types, names, configuration and connections.
    It does not see real traffic, real failures or the real cloud setup.
  * Component categories (database, cache, ...) are guessed from the type and
    name text, e.g. "postgres" is treated as a database.
  * Configuration is free-form, so redundancy is only recognised when common
    keys are present (instances, replicas, multi_az, ...). Otherwise the
    optimizer says it is UNKNOWN and words the finding as a possibility.

Each recommendation therefore carries a `confidence` level and the result lists
which checks were skipped because information was missing.

Optional inputs from the other services make more checks possible:
  * utilization_percentage    (from the performance simulator)
  * total_monthly_cost and monthly_budget (from the cost estimator)

Try it from the backend folder:  python -m services.optimizer
"""

import math
import re
from typing import Literal

from pydantic import BaseModel

from app.schemas.models import (
    ArchitectureComponent,
    ArchitectureConnection,
    ArchitecturePatch,
    ArchitectureResult,
    ComponentUpdate,
)
from app.services.catalog import is_non_core_type
from app.services.patch import free_id
from app.services.performance_analyzer import HIGH_UTILIZATION_ABOVE, TARGET_UTILIZATION

# ---------- Configuration (all rules and keywords live here) ----------

# Words that suggest what a component is. Checked in this order, type first, then name.
CATEGORY_KEYWORDS: dict[str, list[str]] = {
    "load_balancer": ["load balancer", "loadbalancer", "lb", "alb", "elb", "nlb"],
    "cache": ["cache", "redis", "memcached", "elasticache"],
    "database": [
        "database",
        "db",
        "sql",
        "postgres",
        "postgresql",
        "mysql",
        "mariadb",
        "mongodb",
        "dynamodb",
        "rds",
        "aurora",
    ],
    "compute": [
        "compute",
        "server",
        "servers",
        "app",
        "api",
        "web",
        "backend",
        "service",
        "vm",
        "instance",
        "container",
        "ec2",
        "ecs",
        "kubernetes",
        "k8s",
        "lambda",
        "worker",
    ],
}

# Configuration keys that say how many copies of a component run.
COUNT_KEYS = [
    "instances",
    "instance_count",
    "count",
    "nodes",
    "node_count",
    "replicas",
    "desired_count",
    "min_instances",
]
# Configuration keys for a database's read replicas (1 or more means redundancy).
REPLICA_KEYS = ["read_replicas", "replica"]
# Boolean configuration keys that mean the component is built for availability.
REDUNDANCY_FLAGS = ["multi_az", "high_availability", "ha", "autoscaling", "auto_scaling"]

CRITICAL_UTILIZATION_ABOVE = 100.0  # demand is higher than total capacity
BUDGET_NEAR_LIMIT_FRACTION = 0.90  # spending 90%+ of the budget is worth a heads-up
BUDGET_MAJOR_OVERRUN_FRACTION = 0.20  # more than 20% over budget counts as a major overrun
HUB_MIN_CONNECTIONS = 2  # a component with this many links is "central"

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}

NOTICE = (
    "These are rule-based suggestions from limited information (component names, "
    "types, configuration and connections). They point out possible problems, not "
    "confirmed ones. Please review them against your real requirements."
)


# ---------- Result models ----------


class Recommendation(BaseModel):
    id: str  # which rule produced this
    issue: str
    severity: Literal["critical", "high", "medium", "low"]
    confidence: Literal["high", "medium", "low"]  # how sure the rule is, given the data
    explanation: str
    recommendation: str
    affected_components: list[str] = []  # component ids
    fix: ArchitecturePatch | None = None  # a change the user can apply with one click


class OptimizationResult(BaseModel):
    summary: str
    recommendations: list[Recommendation]  # most severe first
    limitations: list[str]  # checks skipped, or things to keep in mind
    notice: str = NOTICE


# ---------- Reading the architecture ----------


def _normalise(text: str) -> str:
    return " " + re.sub(r"[^a-z0-9]+", " ", text.lower()).strip() + " "


def _matches(text: str, category: str) -> bool:
    padded = _normalise(text)
    return any(f" {kw} " in padded for kw in CATEGORY_KEYWORDS[category])


def categorise(component: ArchitectureComponent) -> str:
    """Guess the component's role from its type, then from its name."""
    if is_non_core_type(component.type):
        return "other"
    for text in (component.type, component.name):
        for category in CATEGORY_KEYWORDS:
            if _matches(text, category):
                return category
    return "other"


def _number(value) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _config(component: ArchitectureComponent) -> dict:
    return {str(k).lower(): v for k, v in component.configuration.items()}


def instance_count(component: ArchitectureComponent) -> float | None:
    """How many copies run, if the configuration says so."""
    config = _config(component)
    for key in COUNT_KEYS:
        n = _number(config.get(key))
        if n is not None:
            return n
    return None


def redundancy(component: ArchitectureComponent, category: str) -> Literal["redundant", "single", "unknown"]:
    """Does the configuration show more than one copy, or a high-availability setting?"""
    config = _config(component)

    for flag in REDUNDANCY_FLAGS:
        if config.get(flag) is True or str(config.get(flag)).lower() == "true":
            return "redundant"
    if category == "database":
        for key in REPLICA_KEYS:
            n = _number(config.get(key))
            if n is not None and n >= 1:
                return "redundant"

    count = instance_count(component)
    if count is None:
        return "unknown"
    return "redundant" if count > 1 else "single"


# ---------- The checks ----------
# Each check receives the prepared view of the architecture and returns a list
# of Recommendation objects (empty when nothing is found).


def _count_key(component: ArchitectureComponent) -> str:
    """The configuration key that already holds the instance count, else 'instances'."""
    for key, value in component.configuration.items():
        if key.lower() in COUNT_KEYS and _number(value) is not None:
            return key
    return "instances"


def _scale_update(component: ArchitectureComponent, new_count: int) -> ComponentUpdate:
    return ComponentUpdate(id=component.id, configuration={_count_key(component): new_count})


class View:
    """The architecture plus a few handy lookups, built once."""

    def __init__(self, architecture: ArchitectureResult):
        self.components = architecture.components
        self.connections = architecture.connections
        self.by_id = {c.id: c for c in self.components}
        self.category = {c.id: categorise(c) for c in self.components}
        self.by_category: dict[str, list[ArchitectureComponent]] = {}
        for c in self.components:
            self.by_category.setdefault(self.category[c.id], []).append(c)

    def of(self, category: str) -> list[ArchitectureComponent]:
        return self.by_category.get(category, [])

    def degree(self, component_id: str) -> int:
        """Number of connections that touch this component."""
        return sum(1 for conn in self.connections if conn.source == component_id or conn.target == component_id)


# Words that mark a compute component as background work rather than a web-facing server.
BACKGROUND_WORDS = ("worker", "job", "consumer", "processor", "cron", "batch", "scheduler")


def is_background(view: View, component: ArchitectureComponent) -> bool:
    """A worker: named like one, or fed by a queue. Its load follows the queue, not user traffic."""
    if any(word in f"{component.id} {component.name} {component.type}".lower() for word in BACKGROUND_WORDS):
        return True
    for conn in view.connections:
        if conn.target == component.id:
            source = view.by_id.get(conn.source)
            if source and "queue" in f"{source.type} {source.name}".lower():
                return True
    return False


def web_facing(view: View) -> list[ArchitectureComponent]:
    """Compute components that serve user traffic. Falls back to all compute if every one looks like a worker."""
    compute = view.of("compute")
    serving = [c for c in compute if not is_background(view, c)]
    return serving or compute


def web_facing_ids(architecture: ArchitectureResult) -> set[str]:
    return {c.id for c in web_facing(View(architecture))}


def check_single_database(view: View) -> list[Recommendation]:
    databases = view.of("database")
    if len(databases) != 1:
        return []
    db = databases[0]
    state = redundancy(db, "database")
    if state == "redundant":
        return []

    if state == "single":
        severity, confidence = "high", "high"
        why = (
            f"'{db.name}' is the only database and its configuration shows a single "
            "instance, so if it fails, anything that needs stored data would stop working."
        )
    else:
        severity, confidence = "medium", "medium"
        why = (
            f"'{db.name}' is the only database, and the design doesn't say whether it has "
            "replicas or a standby. If it runs as one instance, a failure would stop anything "
            "that needs stored data. If it is already a managed, replicated service, this may not apply."
        )
    return [
        Recommendation(
            id="single-database",
            issue="Single database",
            severity=severity,
            confidence=confidence,
            explanation=why,
            recommendation="Consider a standby or read replica (for example a multi-AZ setup) "
            "and regular backups, so the database is not a single point of failure.",
            affected_components=[db.id],
            fix=ArchitecturePatch(
                label=f"Enable multi-AZ on '{db.name}'",
                update_components=[ComponentUpdate(id=db.id, configuration={"multi_az": True})],
            ),
        )
    ]


def check_missing_cache(view: View, utilization: float | None) -> list[Recommendation]:
    # A cache mainly takes read load off a database, so only look when there is one.
    if view.of("cache") or not view.of("database"):
        return []

    busy = utilization is not None and utilization > HIGH_UTILIZATION_ABOVE
    explanation = (
        "No component looks like a cache (such as Redis or Memcached). A cache can serve "
        "repeated reads quickly and reduce the load on the database. Whether it would help "
        "depends on how read-heavy the traffic is, which this design doesn't tell us."
    )
    if busy:
        explanation += f" The simulated utilization is {utilization:.0f}%, so reducing load may be especially useful."
    return [
        Recommendation(
            id="missing-cache",
            issue="No cache found",
            severity="medium" if busy else "low",
            confidence="medium",
            explanation=explanation,
            recommendation="If many requests read the same data, consider adding a cache in front "
            "of the database. If traffic is mostly writes, it may not be worth it.",
            affected_components=[c.id for c in view.of("database")],
            fix=_cache_fix(view),
        )
    ]


def _cache_fix(view: View) -> ArchitecturePatch:
    taken = {c.id for c in view.components}
    cache_id = free_id("cache", taken)
    provider = view.of("database")[0].provider
    return ArchitecturePatch(
        label="Add a Redis cache (2 nodes) in front of the database",
        add_components=[
            ArchitectureComponent(
                id=cache_id,
                name="Cache",
                type="cache",
                provider=provider,
                configuration={"engine": "redis", "nodes": 2},
            )
        ],
        add_connections=[
            ArchitectureConnection(source=c.id, target=cache_id, label="cached reads") for c in view.of("compute")
        ],
    )


def check_missing_load_balancer(view: View) -> list[Recommendation]:
    compute = view.of("compute")
    if view.of("load_balancer") or not compute:
        return []

    counts = [instance_count(c) for c in compute]
    several = len(compute) > 1 or any(n is not None and n > 1 for n in counts)
    return [
        Recommendation(
            id="missing-load-balancer",
            issue="No load balancer found",
            severity="medium" if several else "low",
            confidence="medium",
            explanation=(
                "No component looks like a load balancer. "
                + (
                    "There appear to be several application servers, so traffic may not be spread "
                    "evenly, and one server failing could affect users. "
                    if several
                    else "With a single server a load balancer is less urgent, but it becomes important "
                    "as soon as you add more. "
                )
                + "This is based on component names and types, so a load balancer that isn't "
                "listed in the design would be missed."
            ),
            recommendation="Consider placing a load balancer in front of the application servers "
            "to spread traffic and route around failed servers.",
            affected_components=[c.id for c in compute],
            fix=_load_balancer_fix(view),
        )
    ]


def _load_balancer_fix(view: View) -> ArchitecturePatch:
    compute = view.of("compute")
    lb_id = free_id("load-balancer", {c.id for c in view.components})
    return ArchitecturePatch(
        label="Add a load balancer in front of the application servers",
        add_components=[
            ArchitectureComponent(id=lb_id, name="Load Balancer", type="load_balancer", provider=compute[0].provider)
        ],
        add_connections=[ArchitectureConnection(source=lb_id, target=c.id, label="HTTP") for c in compute],
    )


def check_high_utilization(view: View, utilization: float | None) -> list[Recommendation]:
    if utilization is None or utilization <= HIGH_UTILIZATION_ABOVE:
        return []

    over = utilization > CRITICAL_UTILIZATION_ABOVE
    return [
        Recommendation(
            id="high-utilization",
            issue="Servers are over capacity" if over else "High server utilization",
            severity="critical" if over else "high",
            confidence="medium",
            explanation=(
                f"The performance simulation estimates {utilization:.0f}% utilization. "
                + (
                    "That is above 100%, so incoming traffic would be more than the servers can handle. "
                    if over
                    else f"That is above the {HIGH_UTILIZATION_ABOVE:g}% level where there is little room "
                    "for traffic spikes. "
                )
                + "This number comes from a simple model, not a real load test."
            ),
            recommendation="Add servers or increase capacity per server, and confirm the result "
            "with a real load test before relying on it.",
            affected_components=[c.id for c in web_facing(view)],
            fix=_scale_fix(view, utilization),
        )
    ]


def _scale_fix(view: View, utilization: float) -> ArchitecturePatch | None:
    """Scale the web-facing servers so utilization lands near the target (assumes capacity scales with count).

    Background workers are left alone: the load model only counts web-facing servers.
    """
    factor = utilization / TARGET_UTILIZATION
    updates = []
    for c in web_facing(view):
        current = max(1, round(instance_count(c) or 1))
        wanted = min(200, math.ceil(current * factor))
        if wanted > current:
            updates.append(_scale_update(c, wanted))
    if not updates:
        return None
    return ArchitecturePatch(
        label=f"Scale application servers to about {TARGET_UTILIZATION:g}% utilization", update_components=updates
    )


def check_single_points_of_failure(view: View) -> list[Recommendation]:
    explicit: list[ArchitectureComponent] = []
    possible: list[ArchitectureComponent] = []

    for c in view.components:
        category = view.category[c.id]
        if category in ("database", "cache"):
            continue  # databases have their own check; a cache failure degrades rather than breaks
        state = redundancy(c, category)
        if state == "redundant":
            continue
        if category != "other" and len(view.of(category)) > 1:
            continue  # other components of the same kind exist
        if state == "single":
            explicit.append(c)
        elif view.degree(c.id) >= HUB_MIN_CONNECTIONS:
            possible.append(c)

    if not explicit and not possible:
        return []

    lines = []
    for c in explicit:
        lines.append(f"'{c.name}' is configured with a single instance.")
    for c in possible:
        lines.append(
            f"'{c.name}' is the only component of its kind, is connected to "
            f"{view.degree(c.id)} others, and the design doesn't show redundancy."
        )
    return [
        Recommendation(
            id="single-point-of-failure",
            issue="Possible single points of failure",
            severity="medium" if explicit else "low",
            confidence="medium" if explicit else "low",
            explanation=" ".join(lines) + " These may be single points of failure, but some "
            "services (such as managed load balancers) are redundant by default, "
            "which this design may not show.",
            recommendation="Check whether each of these runs in more than one instance or zone. "
            "If not, consider running at least two copies.",
            affected_components=[c.id for c in explicit + possible],
            fix=_redundancy_fix(explicit + possible, view),
        )
    ]


def _redundancy_fix(components: list[ArchitectureComponent], view: View) -> ArchitecturePatch | None:
    """Compute: run 2 copies. Anything else (load balancers, auth, queues...): mark as highly available."""
    updates, scaled, hardened = [], [], []
    for c in components:
        if view.category[c.id] == "compute":
            updates.append(_scale_update(c, 2))
            scaled.append(c.name)
        else:
            flag = "multi_az" if view.category[c.id] == "load_balancer" else "high_availability"
            updates.append(ComponentUpdate(id=c.id, configuration={flag: True}))
            hardened.append(c.name)
    if not updates:
        return None
    parts = []
    if scaled:
        parts.append("run at least 2 copies of " + ", ".join(scaled))
    if hardened:
        parts.append("mark as highly available: " + ", ".join(hardened))
    label = "; ".join(parts)
    return ArchitecturePatch(
        label=label[0].upper() + label[1:], update_components=updates
    )  # keep component names as written


def check_budget(total: float | None, budget: float | None) -> list[Recommendation]:
    if total is None or budget is None:
        return []

    if total > budget:
        over_by = total - budget
        major = budget == 0 or over_by / budget > BUDGET_MAJOR_OVERRUN_FRACTION
        return [
            Recommendation(
                id="over-budget",
                issue="Estimated cost exceeds the budget",
                severity="high" if major else "medium",
                confidence="medium",
                explanation=(
                    f"The estimated monthly cost is {total:,.2f}, which is {over_by:,.2f} over the "
                    f"budget of {budget:,.2f}. The cost uses generic estimated prices, so the real "
                    "difference could be larger or smaller."
                ),
                recommendation="Review the most expensive resources, check whether quantities can be "
                "reduced, compare real provider prices, or revisit the budget.",
            )
        ]

    if budget > 0 and total / budget >= BUDGET_NEAR_LIMIT_FRACTION:
        return [
            Recommendation(
                id="near-budget",
                issue="Estimated cost is close to the budget",
                severity="low",
                confidence="medium",
                explanation=(
                    f"The estimated monthly cost is {total:,.2f}, about {total / budget * 100:.0f}% of "
                    f"the {budget:,.2f} budget. Because this is an estimate, a small price difference "
                    "could push the real cost over the limit."
                ),
                recommendation="Leave some margin, and compare against real provider pricing.",
            )
        ]
    return []


# ---------- Public entry point ----------


def analyze_architecture(
    architecture: ArchitectureResult | dict,
    utilization_percentage: float | None = None,
    total_monthly_cost: float | None = None,
    monthly_budget: float | None = None,
) -> OptimizationResult:
    """Run every check and return the findings, most severe first."""
    if not isinstance(architecture, ArchitectureResult):
        architecture = ArchitectureResult.model_validate(architecture)

    limitations: list[str] = []
    if not architecture.components:
        return OptimizationResult(
            summary="There are no components to analyze.",
            recommendations=[],
            limitations=["The architecture has no components, so no checks could run."],
        )

    view = View(architecture)
    found: list[Recommendation] = []
    found += check_single_database(view)
    found += check_missing_cache(view, utilization_percentage)
    found += check_missing_load_balancer(view)
    found += check_high_utilization(view, utilization_percentage)
    found += check_single_points_of_failure(view)
    found += check_budget(total_monthly_cost, monthly_budget)

    if utilization_percentage is None:
        limitations.append("Server utilization was not provided, so the load check was skipped.")
    if total_monthly_cost is None or monthly_budget is None:
        limitations.append("Cost or budget was not provided, so the budget check was skipped.")
    limitations.append(
        "Component roles are guessed from type and name text, and redundancy is only "
        "recognised from common configuration keys."
    )

    found.sort(key=lambda r: SEVERITY_ORDER[r.severity])

    if found:
        summary = (
            f"Found {len(found)} possible issue{'s' if len(found) != 1 else ''}. "
            "These are suggestions to review, not confirmed problems."
        )
    else:
        summary = (
            "These checks found no issues. That does not mean the design has none, "
            "since the checks only use the limited information available."
        )

    return OptimizationResult(summary=summary, recommendations=found, limitations=limitations)


if __name__ == "__main__":
    demo = ArchitectureResult(
        project_name="Demo shop",
        components=[
            {"id": "api-1", "name": "API Server", "type": "compute", "provider": "aws"},
            {
                "id": "db-1",
                "name": "Primary Database",
                "type": "database",
                "provider": "aws",
                "configuration": {"engine": "postgres"},
            },
        ],
        connections=[{"source": "api-1", "target": "db-1", "label": "reads/writes"}],
    )
    print(
        analyze_architecture(
            demo, utilization_percentage=92, total_monthly_cost=520, monthly_budget=450
        ).model_dump_json(indent=2)
    )
