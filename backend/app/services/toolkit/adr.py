"""Architecture decision records: for each major choice in the design, the context, what was chosen, the
alternatives and their trade-offs, and the consequences. Written from the components actually in the design, so
the record says what it really chose. All start as "Proposed": a team reviews and accepts them.
"""

from __future__ import annotations

from app.schemas.models import ArchitectureResult, Requirements
from app.schemas.toolkit import Alternative, DecisionRecord, DecisionsResponse
from app.services.toolkit.capacity import peak_requests
from app.services.toolkit.common import Context, build_context, human, md


def alt(name: str, pros: list[str], cons: list[str]) -> Alternative:
    return Alternative(name=name, pros=pros, cons=cons)


def _context_line(ctx: Context, subject: str) -> str:
    users = ctx.reqs.expected_users
    scale = f"about {human(users, 0)} users and " if users else ""
    return (
        f"A {ctx.domain if ctx.domain != 'generic' else 'general-purpose'} application with {scale}a peak of roughly "
        f"{peak_requests(ctx.reqs):,.0f} requests per second needs {subject}."
    )


def _compute(ctx: Context) -> DecisionRecord | None:
    if not ctx.web:
        return None
    kinds = {c.type.lower() for c in ctx.web}
    count = sum(ctx.count(c) for c in ctx.web)
    names = ", ".join(c.name for c in ctx.web)
    if "serverless" in kinds:
        choice, why = "Serverless functions", "pay only for the requests served and no servers to patch"
    elif "container" in kinds:
        choice, why = "Containers", "the same package runs everywhere and scales by adding copies"
    else:
        choice, why = "Virtual machines (instances)", "simple, familiar, and easy to reason about"
    return DecisionRecord(
        id="",
        title="How the application code runs",
        context=_context_line(ctx, "somewhere to run its application code"),
        decision=f"Run the application as {choice.lower()}: {names} ({count} instance(s) in total), because {why}.",
        alternatives=[
            alt(
                "Containers on a managed orchestrator",
                ["Portable, dense packing, rolling deploys"],
                ["More moving parts to operate and learn"],
            ),
            alt(
                "Virtual machines",
                ["Simplest model, full control"],
                ["Slower to scale, you patch the operating system"],
            ),
            alt(
                "Serverless functions",
                ["No idle cost, scales to zero"],
                ["Cold starts, execution limits, harder local debugging"],
            ),
        ],
        consequences=[
            f"{count} copies of the application means a failed instance is replaced without an outage, if a load balancer spreads traffic.",
            "Application servers must stay stateless: sessions and uploads belong in a cache or storage, not on the server.",
        ],
        components=[c.id for c in ctx.web],
    )


def _database(ctx: Context) -> DecisionRecord | None:
    db = ctx.first("database")
    if not db:
        return None
    engine = ctx.db_engine() or "an unspecified engine"
    az = db.configuration.get("multi_az") is True
    replicas = int(db.configuration.get("read_replicas") or 0)
    return DecisionRecord(
        id="",
        title="Primary data store",
        context=_context_line(ctx, "a durable place for its core data"),
        decision=f"Use {db.name} ({engine}) as the system of record, "
        + ("spread across two availability zones with automatic failover" if az else "in a single availability zone")
        + (f", with {replicas} read replica(s)" if replicas else "")
        + ".",
        alternatives=[
            alt(
                "Relational database (PostgreSQL, MySQL)",
                ["Transactions, joins and constraints keep data correct"],
                ["Scaling writes beyond one machine needs sharding"],
            ),
            alt(
                "Document database (MongoDB)",
                ["Flexible shape, easy horizontal scaling"],
                ["Weaker joins and cross-document transactions"],
            ),
            alt(
                "Key-value / wide-column (DynamoDB, Cassandra)",
                ["Near-unlimited scale and predictable latency"],
                ["You must design around the queries up front; limited ad-hoc queries"],
            ),
        ],
        consequences=[
            "Backups and point-in-time recovery decide how much data can be lost (the RPO): confirm they are on.",
            "Multi-zone failover protects against a zone outage, not against bad data written by a bug."
            if az
            else "A single zone means a zone outage takes the database down until it is restored.",
            "If the data will outgrow one instance, a shard key has to be chosen early (see the capacity estimate).",
        ],
        components=[db.id],
    )


def _cache(ctx: Context) -> DecisionRecord | None:
    cache = ctx.first("cache")
    if not cache:
        return None
    nodes = ctx.count(cache)
    return DecisionRecord(
        id="",
        title="Caching",
        context=_context_line(ctx, "fast reads without hammering the database"),
        decision=f"Put {cache.name} ({nodes} node(s)) in front of the database and use the cache-aside pattern: read the cache first, "
        "fill it on a miss, and expire entries after a time-to-live.",
        alternatives=[
            alt(
                "Redis",
                ["Rich data types, persistence option, pub/sub"],
                ["Single-threaded per shard; more to operate"],
            ),
            alt("Memcached", ["Simple, very fast, multi-threaded"], ["Strings only, no persistence"]),
            alt(
                "No cache (database only)",
                ["One less system to run, no stale data"],
                ["The database carries all read load"],
            ),
        ],
        consequences=[
            "Readers may see data that is slightly out of date until entries expire: decide what staleness is acceptable.",
            "A cold cache after a restart sends a burst of traffic to the database: plan for it.",
            "The application must keep working (slower) when the cache is down."
            + (" With one node, that is a risk." if nodes < 2 else ""),
        ],
        components=[cache.id],
    )


def _queue(ctx: Context) -> DecisionRecord | None:
    queue = ctx.first("queue")
    if not queue:
        return None
    workers = ", ".join(c.name for c in ctx.with_role("worker")) or "background workers"
    return DecisionRecord(
        id="",
        title="Asynchronous processing",
        context=_context_line(ctx, "slow or unreliable work kept off the request path"),
        decision=f"Hand work to {queue.name} and process it with {workers}, so a request can be answered before the work is done.",
        alternatives=[
            alt(
                "Managed queue (SQS)", ["No servers, simple, scales on its own"], ["No ordering by default, no replay"]
            ),
            alt(
                "Log or stream (Kafka)",
                ["Replayable, ordered per key, many consumers"],
                ["Heavier to run, more concepts"],
            ),
            alt(
                "Do it inside the request",
                ["Simplest, one place to look"],
                ["Slow responses and failures reach the user"],
            ),
        ],
        consequences=[
            "Messages can be delivered more than once: handlers must be idempotent.",
            "A dead-letter queue is needed for messages that keep failing, or one bad message blocks progress.",
            "The user sees 'accepted' rather than 'done': the interface has to show progress.",
        ],
        components=[queue.id, *[c.id for c in ctx.with_role("worker")]],
    )


def _entry(ctx: Context) -> DecisionRecord | None:
    entry = ctx.first("entry")
    if not entry:
        return None
    return DecisionRecord(
        id="",
        title="Entry point and load balancing",
        context=_context_line(ctx, "one stable front door for many servers"),
        decision=f"Route all traffic through {entry.name}, which spreads requests across the application servers and stops sending to unhealthy ones.",
        alternatives=[
            alt(
                "Application load balancer",
                ["Understands HTTP, path routing, health checks"],
                ["Slightly higher cost than a network balancer"],
            ),
            alt("API gateway", ["Auth, throttling and request shaping built in"], ["Per-request cost; another hop"]),
            alt("DNS round robin", ["Nothing to run"], ["No health checks; slow to react to failures"]),
        ],
        consequences=[
            "The entry point itself must be redundant (managed services usually are); check the setup.",
            "TLS is ended here: certificates and renewal need an owner.",
        ],
        components=[entry.id],
    )


def _cdn(ctx: Context) -> DecisionRecord | None:
    cdn = ctx.first("cdn")
    if not cdn:
        return None
    return DecisionRecord(
        id="",
        title="Content delivery",
        context=_context_line(ctx, "fast delivery of static content to users everywhere"),
        decision=f"Serve static and cacheable content through {cdn.name}, so most downloads never reach the origin.",
        alternatives=[
            alt(
                "CDN in front of the origin",
                ["Lower latency worldwide, less origin load and egress"],
                ["Cache invalidation, another vendor"],
            ),
            alt(
                "Serve everything from the servers",
                ["Simplest"],
                ["Slow for distant users; servers carry all the bandwidth"],
            ),
        ],
        consequences=[
            "Choose cache lifetimes carefully: long ones are fast but make urgent fixes slow to reach users."
        ],
        components=[cdn.id],
    )


def _auth(ctx: Context) -> DecisionRecord | None:
    auth = ctx.first("auth")
    if not auth:
        return None
    return DecisionRecord(
        id="",
        title="Authentication",
        context=_context_line(ctx, "a safe way to know who is calling"),
        decision=f"Use {auth.name} to handle sign-up, sign-in and tokens, instead of building password handling in the application.",
        alternatives=[
            alt(
                "Managed identity service (Cognito, Auth0)",
                ["Security expertise built in, MFA and social sign-in included"],
                ["Per-user cost, some lock-in"],
            ),
            alt(
                "Build it yourself", ["Full control"], ["Easy to get subtly wrong; you own every future vulnerability"]
            ),
            alt("Open-source identity server (Keycloak)", ["No per-user fee, flexible"], ["You run and patch it"]),
        ],
        consequences=[
            "Tokens must be short-lived and checked on every request.",
            "Moving to another provider later means migrating users and passwords.",
        ],
        components=[auth.id],
    )


def _storage(ctx: Context) -> DecisionRecord | None:
    storage = ctx.first("storage")
    if not storage:
        return None
    return DecisionRecord(
        id="",
        title="File and media storage",
        context=_context_line(ctx, "somewhere cheap and durable for large files"),
        decision=f"Keep files in {storage.name} (object storage) and store only their keys in the database.",
        alternatives=[
            alt(
                "Object storage",
                ["Very durable, cheap, scales without limit"],
                ["Not for frequently changing small records"],
            ),
            alt(
                "Files in the database", ["One place, transactional"], ["Bloats the database, expensive, slow backups"]
            ),
            alt("Network file system", ["Looks like a normal disk"], ["Costly, harder to scale and secure"]),
        ],
        consequences=[
            "Uploads should go directly to storage with signed URLs, never through the servers.",
            "Block public access by default and serve through the CDN.",
        ],
        components=[storage.id],
    )


def _search(ctx: Context) -> DecisionRecord | None:
    search = ctx.first("search")
    if not search:
        return None
    return DecisionRecord(
        id="",
        title="Search",
        context=_context_line(ctx, "fast text search and filtering"),
        decision=f"Use {search.name} as a search index fed from the database, rather than searching the database directly.",
        alternatives=[
            alt(
                "Dedicated search engine (OpenSearch)",
                ["Relevance ranking, typo tolerance, facets"],
                ["A second copy of the data to keep in sync"],
            ),
            alt(
                "Database full-text search",
                ["No extra system, always consistent"],
                ["Limited ranking, slower on large data"],
            ),
        ],
        consequences=[
            "Search results lag the database slightly: updates arrive through a pipeline.",
            "The index can be rebuilt from the database, so it is not the source of truth.",
        ],
        components=[search.id],
    )


def _availability(ctx: Context) -> DecisionRecord | None:
    db = ctx.first("database")
    web = ctx.web
    if not web and not db:
        return None
    web_count = sum(ctx.count(c) for c in web)
    parts = [f"{web_count} application instance(s)"]
    if db:
        parts.append("a multi-zone database" if db.configuration.get("multi_az") is True else "a single-zone database")
    target = ctx.reqs.reliability.availability_percent or ctx.reqs.availability_target
    return DecisionRecord(
        id="",
        title="Availability and failure handling",
        context=_context_line(ctx, "to keep serving users when parts fail")
        + (f" The availability target is {target}." if target else ""),
        decision=f"Run {' and '.join(parts)} and rely on health checks and automatic replacement; do not target more than one region for now.",
        alternatives=[
            alt("Single zone", ["Cheapest, simplest"], ["A zone outage is a full outage"]),
            alt(
                "Multiple zones in one region",
                ["Survives a zone failure at modest cost"],
                ["Still exposed to a regional outage"],
            ),
            alt(
                "Multiple regions",
                ["Survives a regional outage, lower latency worldwide"],
                ["Much more complex and costly; data consistency is hard"],
            ),
        ],
        consequences=[
            "See the reliability tool for the estimated availability, recovery time and recovery point of this design."
        ],
        components=[c.id for c in web] + ([db.id] if db else []),
    )


BUILDERS = [_compute, _entry, _cdn, _auth, _database, _cache, _queue, _storage, _search, _availability]


def render_markdown(project: str, records: list[DecisionRecord]) -> str:
    out = [
        f"# Architecture decision records: {md(project)}",
        "",
        "Generated by SysDesign AI. Review each record, edit it to match what your team decides, then set its status to Accepted.",
        "",
    ]
    for r in records:
        out += [
            f"## {r.id}: {md(r.title)}",
            "",
            f"**Status:** {r.status}",
            "",
            f"**Context.** {md(r.context)}",
            "",
            f"**Decision.** {md(r.decision)}",
            "",
            "**Alternatives considered**",
            "",
        ]
        for a in r.alternatives:
            out.append(f"- **{md(a.name)}**. Pros: {md('; '.join(a.pros))}. Cons: {md('; '.join(a.cons))}.")
        out += ["", "**Consequences**", ""]
        out += [f"- {md(c)}" for c in r.consequences]
        out.append("")
    return "\n".join(out)


def build_decisions(arch: ArchitectureResult, reqs: Requirements) -> DecisionsResponse:
    ctx = build_context(arch, reqs)
    records = [r for build in BUILDERS if (r := build(ctx)) is not None]
    for i, record in enumerate(records, start=1):
        record.id = f"ADR-{i:03d}"
    return DecisionsResponse(records=records, markdown=render_markdown(arch.project_name, records))
