"""Design pattern suggestions: which well-known patterns this design already uses, which it would benefit from, and
which it does not need yet, each with the evidence from the design, when to use it, when not to, and the trade-offs.
Patterns that add something to the diagram come with a fix that can be applied in one click.
"""

from __future__ import annotations

from typing import Any

from app.schemas.models import (
    ArchitectureComponent,
    ArchitectureConnection,
    ArchitecturePatch,
    ArchitectureResult,
    ComponentUpdate,
    Requirements,
)
from app.schemas.toolkit import PatternsResponse, PatternSuggestion
from app.services.patch import free_id
from app.services.recommendation_engine import _cache_fix
from app.services.toolkit.capacity import estimate_for_context
from app.services.toolkit.common import Context, build_context, some

WRITE_SIDE_DOMAINS = {"ecommerce", "booking", "video", "social", "messaging"}
STATEFUL_ROLES = ("database", "cache", "search", "auth", "queue", "storage")


def pattern(
    id_: str,
    name: str,
    status: str,
    summary: str,
    why: str,
    when_to_use: str,
    when_not_to: str,
    trade_offs: str,
    how: str,
    fix: ArchitecturePatch | None = None,
) -> PatternSuggestion:
    return PatternSuggestion(
        id=id_,
        name=name,
        status=status,
        summary=summary,
        why=why,
        when_to_use=when_to_use,
        when_not_to=when_not_to,
        trade_offs=trade_offs,
        how=how,
        fix=fix,
    )


def _provider(ctx: Context) -> str:
    return (ctx.web[0] if ctx.web else ctx.arch.components[0]).provider


def _taken(ctx: Context) -> set[str]:
    return {c.id for c in ctx.arch.components}


def _has_flag(components: list[ArchitectureComponent], *keys: str) -> bool:
    return any(
        str(c.configuration.get(k)).lower() == "true" or c.configuration.get(k) is True
        for c in components
        for k in keys
    )


def _cache_aside(ctx: Context) -> PatternSuggestion:
    read = ctx.reqs.traffic_profile.read_ratio
    base: dict[str, Any] = dict(
        id_="cache-aside",
        name="Cache-aside (caching)",
        summary="Keep frequently read data in fast memory so most reads never reach the database.",
        when_to_use="Reads far outnumber writes and the same data is read again and again.",
        when_not_to="Data changes on every request, or stale data is unacceptable (for example account balances).",
        trade_offs="Faster reads and a calmer database, in exchange for stale data until entries expire and one more system to run.",
    )
    if ctx.first("cache"):
        return pattern(
            status="in place",
            why=f"The design already has {some(ctx.first('cache')).name}.",
            how="Check the time-to-live of each cached item and what happens when the cache is empty.",
            **base,
        )
    if not ctx.first("database"):
        return pattern(
            status="not needed",
            why="There is no database whose load a cache could reduce.",
            how="Revisit once the design has a database.",
            **base,
        )
    status = "recommended" if read >= 0.7 else "consider"
    return pattern(
        status=status,
        why=f"{read:.0%} of requests only read data and there is no cache, so every read reaches the database.",
        how="Add a Redis cache next to the application servers and read through it.",
        fix=_cache_fix(ctx.view),
        **base,
    )


def _cdn(ctx: Context) -> PatternSuggestion:
    base: dict[str, Any] = dict(
        id_="cdn-offload",
        name="CDN offload",
        summary="Serve images, scripts and other static files from servers close to the user instead of from your own.",
        when_to_use="Users are spread across regions, or a large part of the traffic is static files and media.",
        when_not_to="All users sit next to one region and there is little static content.",
        trade_offs="Lower latency and bandwidth cost, but cache invalidation to manage and another vendor in the path.",
    )
    if ctx.first("cdn"):
        return pattern(
            status="in place",
            why=f"{some(ctx.first('cdn')).name} is already in front of the origin.",
            how="Set long cache lifetimes for versioned files and a short one for pages.",
            **base,
        )
    heavy = ctx.domain in {"video", "ecommerce", "social"} or ctx.first("storage") is not None
    if not heavy and ctx.reqs.traffic_profile.read_ratio < 0.7:
        return pattern(
            status="not needed",
            why="Little static or media content is expected.",
            how="Revisit if downloads or users grow.",
            **base,
        )
    origin = ctx.first("entry") or ctx.first("storage")
    cdn_id = free_id("cdn", _taken(ctx))
    fix = ArchitecturePatch(
        label="Add a CDN in front of the origin",
        add_components=[ArchitectureComponent(id=cdn_id, name="CDN", type="cdn", provider=_provider(ctx))],
        add_connections=[ArchitectureConnection(source=cdn_id, target=origin.id, label="origin")] if origin else [],
    )
    return pattern(
        status="recommended" if heavy else "consider",
        why="The design serves "
        + ("media and product images" if heavy else "mostly reads")
        + " directly from its own servers.",
        how="Put a CDN in front of the load balancer or the storage bucket.",
        fix=fix,
        **base,
    )


def _read_replicas(ctx: Context) -> PatternSuggestion:
    read = ctx.reqs.traffic_profile.read_ratio
    base: dict[str, Any] = dict(
        id_="read-replicas",
        name="Read replicas",
        summary="Copy the database to extra read-only servers and send reads to them.",
        when_to_use="Reads dominate and the primary database is the bottleneck even with a cache.",
        when_not_to="Writes dominate, or reads must always see the newest write.",
        trade_offs="More read capacity and a spare copy, but replicas lag the primary, so a read right after a write can be stale.",
    )
    db = ctx.first("database")
    if not db:
        return pattern(status="not needed", why="There is no database.", how="Revisit once there is one.", **base)
    if int(db.configuration.get("read_replicas") or 0) > 0:
        return pattern(
            status="in place",
            why=f"{db.name} already has read replicas.",
            how="Route reporting and search queries to the replicas.",
            **base,
        )
    if read < 0.6:
        return pattern(
            status="not needed",
            why=f"Only {read:.0%} of requests read, so replicas would help little.",
            how="Look at write scaling (sharding) first.",
            **base,
        )
    fix = ArchitecturePatch(
        label="Add one read replica", update_components=[ComponentUpdate(id=db.id, configuration={"read_replicas": 1})]
    )
    return pattern(
        status="consider" if read < 0.8 else "recommended",
        why=f"{read:.0%} of requests are reads, all served by one primary database.",
        how="Add a replica and send read-only queries to it.",
        fix=fix,
        **base,
    )


def _async_queue(ctx: Context) -> PatternSuggestion:
    base: dict[str, Any] = dict(
        id_="event-driven",
        name="Event-driven processing (queue and workers)",
        summary="Answer the user quickly and do slow or unreliable work in the background, driven by messages.",
        when_to_use="A request triggers work that can finish later: emails, payments follow-up, image processing, indexing.",
        when_not_to="The user needs the result of the work in the same response.",
        trade_offs="Faster responses and isolation from failures, but eventual consistency, duplicate deliveries to handle and more to monitor.",
    )
    if ctx.first("queue"):
        return pattern(
            status="in place",
            why=f"{some(ctx.first('queue')).name} already decouples slow work.",
            how="Make handlers idempotent and set up a dead-letter queue.",
            **base,
        )
    if not ctx.web or ctx.domain not in WRITE_SIDE_DOMAINS:
        return pattern(
            status="not needed",
            why="Nothing in the design suggests slow follow-up work.",
            how="Revisit if requests start doing heavy work.",
            **base,
        )
    taken = _taken(ctx)
    queue_id, worker_id = free_id("job-queue", taken), free_id("worker", taken | {"job-queue"})
    api = ctx.web[0]
    fix = ArchitecturePatch(
        label="Add a job queue and a background worker",
        add_components=[
            ArchitectureComponent(id=queue_id, name="Job Queue", type="queue", provider=_provider(ctx)),
            ArchitectureComponent(
                id=worker_id,
                name="Background Worker",
                type="compute",
                provider=_provider(ctx),
                configuration={"instances": 1},
            ),
        ],
        add_connections=[
            ArchitectureConnection(source=api.id, target=queue_id, label="enqueue work"),
            ArchitectureConnection(source=queue_id, target=worker_id, label="deliver"),
        ]
        + (
            [ArchitectureConnection(source=worker_id, target=some(ctx.first("database")).id, label="update records")]
            if ctx.first("database")
            else []
        ),
    )
    return pattern(
        status="recommended",
        why=f"A {ctx.domain} application does follow-up work after writes, and the design has no queue, so it would run inside the request.",
        how="Add a queue and a worker; the API enqueues and returns immediately.",
        fix=fix,
        **base,
    )


def _circuit_breaker(ctx: Context) -> PatternSuggestion:
    base: dict[str, Any] = dict(
        id_="circuit-breaker",
        name="Circuit breaker and retries",
        summary="Stop calling a failing dependency for a while, so one broken service does not drag everything down.",
        when_to_use="A service calls other services or external APIs that can be slow or fail.",
        when_not_to="A service has no dependencies, or calls are always fast and local.",
        trade_offs="Prevents cascading failures, but needs sensible timeouts, fallbacks and tuning, or it will trip when it should not.",
    )
    if not ctx.web:
        return pattern(
            status="not needed", why="There is no application server.", how="Revisit once there is one.", **base
        )
    downstream = {
        r
        for c in ctx.web
        for r in (
            ctx.roles[t.id]
            for t in ctx.view.by_id.values()
            if any({x.source, x.target} == {c.id, t.id} for x in ctx.arch.connections)
        )
        if r in STATEFUL_ROLES
    }
    if _has_flag(ctx.web, "circuit_breaker", "resilience"):
        return pattern(
            status="in place",
            why="The web components are marked as using circuit breakers.",
            how="Set timeouts shorter than the caller's, and define a fallback for each dependency.",
            **base,
        )
    if len(downstream) < 2:
        return pattern(
            status="not needed",
            why=f"The application depends on {len(downstream)} other service(s); not yet worth the extra code.",
            how="Revisit as dependencies are added.",
            **base,
        )
    fix = ArchitecturePatch(
        label="Mark the web tier as using circuit breakers",
        update_components=[ComponentUpdate(id=c.id, configuration={"circuit_breaker": True}) for c in ctx.web],
    )
    return pattern(
        status="recommended" if len(downstream) >= 3 else "consider",
        why=f"The application calls {len(downstream)} different dependencies ({', '.join(sorted(downstream))}); any of them can fail or slow down.",
        how="Wrap each call in a timeout, a bounded retry with backoff, and a circuit breaker. The setting only records the decision: the code has to implement it.",
        fix=fix,
        **base,
    )


def _saga(ctx: Context) -> PatternSuggestion:
    base: dict[str, Any] = dict(
        id_="saga",
        name="Saga (distributed transactions)",
        summary="Break a business operation that spans services into steps, each with an undo step, instead of one big transaction.",
        when_to_use="One operation must update data owned by several services (order, payment and stock), and a single database transaction cannot cover them.",
        when_not_to="All the data lives in one database: a normal transaction is simpler and safer.",
        trade_offs="Works across services and scales, but is much harder to reason about: partial failures, compensations and eventual consistency.",
    )
    databases = len(ctx.with_role("database"))
    if databases >= 2:
        return pattern(
            status="recommended",
            why=f"The design has {databases} databases, so one operation cannot be a single transaction.",
            how="Model each multi-service operation as steps with compensating actions, coordinated by events or an orchestrator.",
            **base,
        )
    if ctx.domain in {"ecommerce", "booking"}:
        return pattern(
            status="consider",
            why="Orders and payments often involve an outside payment provider that cannot join a database transaction.",
            how="Record the order as 'pending', take payment, then confirm or cancel it with a compensating step.",
            **base,
        )
    return pattern(
        status="not needed",
        why="Everything is in one database and no external payment step is expected.",
        how="Use ordinary transactions.",
        **base,
    )


def _cqrs(ctx: Context) -> PatternSuggestion:
    read = ctx.reqs.traffic_profile.read_ratio
    base: dict[str, Any] = dict(
        id_="cqrs",
        name="CQRS (separate read and write models)",
        summary="Use one model for writes and a differently shaped, faster one for reads.",
        when_to_use="Reads and writes have very different shapes or scale (for example search, feeds or dashboards over the same data).",
        when_not_to="A simple create-read-update-delete application: the extra moving parts are not worth it.",
        trade_offs="Each side can be optimised and scaled alone, but the read model lags the write model and you maintain two models.",
    )
    if ctx.first("search") and ctx.first("database"):
        return pattern(
            status="in place",
            why="The search index is already a separately shaped read model fed from the database.",
            how="Keep the update pipeline reliable and rebuildable.",
            **base,
        )
    if read >= 0.9 and ctx.first("database"):
        return pattern(
            status="consider",
            why=f"{read:.0%} of requests read, so a read-optimised model could pay off.",
            how="Start with a cache or search index built from the database before a full split.",
            **base,
        )
    return pattern(
        status="not needed",
        why="Reads and writes are balanced enough for one model.",
        how="Revisit if read patterns diverge.",
        **base,
    )


def _api_gateway(ctx: Context) -> PatternSuggestion:
    base: dict[str, Any] = dict(
        id_="api-gateway",
        name="API gateway",
        summary="One front door that handles authentication, throttling and routing to many services.",
        when_to_use="Several services are exposed to clients, or you need rate limiting and request shaping in one place.",
        when_not_to="A single service behind a load balancer: the gateway adds cost and a hop for little gain.",
        trade_offs="Central control and simpler clients, but one more component that must itself be highly available.",
    )
    if any(c.type.lower() == "api_gateway" for c in ctx.arch.components):
        return pattern(
            status="in place",
            why="An API gateway is already in the design.",
            how="Keep business logic out of it.",
            **base,
        )
    if len(ctx.web) < 2:
        return pattern(
            status="not needed",
            why=f"Only {len(ctx.web)} web-facing service: a load balancer is enough.",
            how="Revisit when you split into services.",
            **base,
        )
    gw_id = free_id("api-gateway", _taken(ctx))
    fix = ArchitecturePatch(
        label="Add an API gateway in front of the services",
        add_components=[
            ArchitectureComponent(id=gw_id, name="API Gateway", type="api_gateway", provider=_provider(ctx))
        ],
        add_connections=[ArchitectureConnection(source=gw_id, target=c.id, label="route") for c in ctx.web],
    )
    return pattern(
        status="recommended",
        why=f"{len(ctx.web)} web-facing services are exposed without a single entry point.",
        how="Route all client traffic through a gateway.",
        fix=fix,
        **base,
    )


def _rate_limit(ctx: Context) -> PatternSuggestion:
    base: dict[str, Any] = dict(
        id_="rate-limiting",
        name="Rate limiting and bulkheads",
        summary="Cap how much any one caller can use, and keep resources for different jobs separate.",
        when_to_use="Any public API: one noisy or abusive client must not take everyone down.",
        when_not_to="A private internal service with a handful of trusted callers.",
        trade_offs="Protects availability and cost, but limits have to be chosen well and clients need clear 429 responses.",
    )
    if not ctx.web:
        return pattern(status="not needed", why="There is no public service.", how="Revisit once there is one.", **base)
    if any(c.type.lower() == "api_gateway" for c in ctx.arch.components) or _has_flag(
        ctx.web, "rate_limit", "rate_limiting"
    ):
        return pattern(
            status="in place",
            why="A gateway or a rate-limit setting is present.",
            how="Limit per user and per IP, and return 429 with Retry-After.",
            **base,
        )
    return pattern(
        status="consider",
        why="The services are reachable by clients and nothing limits how much one caller can use.",
        how="Add limits at the gateway or load balancer, and give background workers their own pool so they cannot starve the web tier.",
        **base,
    )


def _sharding(ctx: Context) -> PatternSuggestion:
    base: dict[str, Any] = dict(
        id_="sharding",
        name="Sharding (partitioning data)",
        summary="Split one big dataset across several databases by a key such as the user id.",
        when_to_use="Data or write load no longer fits one database even after caching and replicas.",
        when_not_to="One database still has room: sharding makes queries, joins and operations much harder.",
        trade_offs="Near-unlimited scale, but no easy cross-shard queries or transactions, and re-sharding later is painful.",
    )
    estimate = estimate_for_context(ctx)
    shards = next((line.value for line in estimate.lines if line.label == "Shards needed"), 1.0)
    if shards > 1:
        return pattern(
            status="recommended",
            why=f"The capacity estimate needs {int(shards)} shards (storage and/or request rate beyond one database).",
            how="Pick a shard key now, usually the owner's id, and keep related rows together.",
            **base,
        )
    return pattern(
        status="not needed",
        why="The capacity estimate fits one database instance (1 shard).",
        how="Use caching and replicas first; plan the shard key in case it changes.",
        **base,
    )


def _autoscaling(ctx: Context) -> PatternSuggestion:
    profile = ctx.reqs.traffic_profile
    base: dict[str, Any] = dict(
        id_="autoscaling",
        name="Autoscaling",
        summary="Add and remove servers automatically as traffic rises and falls.",
        when_to_use="Traffic varies a lot over the day or has surges, and servers are stateless.",
        when_not_to="Traffic is flat and predictable, or servers hold state that cannot move.",
        trade_offs="Handles surges and saves money off-peak, but needs good metrics, limits and warm-up time; scaling is never instant.",
    )
    if not ctx.web:
        return pattern(
            status="not needed", why="There are no application servers.", how="Revisit once there are.", **base
        )
    if _has_flag(ctx.web, "autoscaling", "auto_scaling"):
        return pattern(
            status="in place",
            why="The web components are marked as autoscaling.",
            how="Set minimum, maximum and a target such as 70% CPU.",
            **base,
        )
    spiky = profile.surge_multiplier > 1 or profile.peak_to_average >= 5
    fix = ArchitecturePatch(
        label="Turn on autoscaling for the web tier",
        update_components=[ComponentUpdate(id=c.id, configuration={"autoscaling": True}) for c in ctx.web],
    )
    return pattern(
        status="recommended" if spiky else "consider",
        why=f"Peak traffic is {profile.peak_to_average:g}x the daily average"
        + (f" with {profile.surge_multiplier:g}x surges" if profile.surge_multiplier > 1 else "")
        + ", and the server count is fixed.",
        how="Use an autoscaling group (or an autoscaler for containers) between a minimum and a maximum.",
        fix=fix,
        **base,
    )


BUILDERS = [
    _cache_aside,
    _cdn,
    _read_replicas,
    _async_queue,
    _api_gateway,
    _rate_limit,
    _circuit_breaker,
    _saga,
    _cqrs,
    _sharding,
    _autoscaling,
]
ORDER = {"recommended": 0, "consider": 1, "in place": 2, "not needed": 3}


def suggest_patterns(arch: ArchitectureResult, reqs: Requirements) -> PatternsResponse:
    ctx = build_context(arch, reqs)
    patterns = [build(ctx) for build in BUILDERS]
    patterns.sort(key=lambda p: ORDER[p.status])
    return PatternsResponse(patterns=patterns)
