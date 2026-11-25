"""Explain one component: what it is, what it does in this design, what it talks to, what else could be used
there, and the common mistakes."""

from __future__ import annotations

from app.schemas.models import ArchitectureResult, Requirements
from app.schemas.toolkit import ExplainAlternative, ExplainResponse
from app.services.toolkit.common import build_context, neighbours
from app.services.toolkit.glossary import GLOSSARY, terms_in

# role -> (what it is, [(alternative, choose when)], [pitfalls])
KNOWLEDGE: dict[str, tuple[str, list[tuple[str, str]], list[str]]] = {
    "cdn": (
        "A content delivery network keeps copies of your files in many locations so users download them from somewhere nearby.",
        [
            ("Serve files from your own servers", "traffic is small or all users are in one place"),
            ("Object storage with public access", "you only need cheap static hosting without caching rules"),
        ],
        [
            "Forgetting to set cache lifetimes, so nothing is cached or everything is cached too long.",
            "No plan for clearing a cached file after it changes: use versioned file names.",
        ],
    ),
    "entry": (
        "The front door: it receives every request, spreads them across the servers and stops sending to servers that fail health checks.",
        [
            ("API gateway", "you also want authentication, rate limiting and request routing in one place"),
            ("Reverse proxy such as Nginx", "you run your own servers and want full control"),
        ],
        [
            "Running a single load balancer instance: it becomes the single point of failure.",
            "Health checks that are too shallow, so a broken server still looks healthy.",
        ],
    ),
    "api": (
        "The application servers: they run your business logic, answer requests and talk to the database and cache.",
        [
            ("Serverless functions", "traffic is spiky or very low and you want no idle cost"),
            ("One larger server", "the system is small and simplicity matters more than redundancy"),
            ("Containers on Kubernetes", "you have many services and need fine control of scaling"),
        ],
        [
            "Keeping user sessions in server memory, so a second copy cannot take over: keep state in the database or cache.",
            "Running one instance only: one failure is an outage.",
        ],
    ),
    "worker": (
        "Background processors that take jobs from a queue and do slow or non-urgent work away from the user's request.",
        [
            ("Scheduled jobs", "the work happens on a timetable rather than in response to events"),
            ("Serverless functions triggered by the queue", "the load is irregular"),
        ],
        [
            "Jobs that are not safe to run twice: queues deliver at least once, so make jobs idempotent.",
            "No dead-letter queue, so one bad message blocks or loops forever.",
        ],
    ),
    "auth": (
        "Handles sign-up, sign-in and checking who a user is, so your own code does not have to store passwords.",
        [
            ("Build it yourself", "you have unusual requirements and a team to own the security risk"),
            ("Another identity provider", "your customers already use a particular one"),
        ],
        ["Storing passwords without a slow, salted hash.", "Tokens that never expire or cannot be revoked."],
    ),
    "cache": (
        "A fast in-memory store holding copies of frequently read data so the database is asked less often.",
        [
            ("Cache in the application process", "the data is small and a single server is enough"),
            ("CDN", "the data is public files or whole pages"),
        ],
        [
            "No expiry or invalidation, so users see stale data.",
            "Treating the cache as the only copy of anything: it can be emptied at any time.",
            "A cold cache after a restart sending the whole load to the database at once.",
        ],
    ),
    "database": (
        "The system of record: where the data that must not be lost is stored and queried.",
        [
            ("Document store such as MongoDB", "records vary in shape and you rarely join across them"),
            ("Key-value store such as DynamoDB", "access is by key and you need very high scale"),
            ("Relational database such as PostgreSQL", "data has clear relations and needs transactions"),
        ],
        [
            "Running a single instance without backups.",
            "Missing indexes on columns used in searches, which gets slower as data grows.",
            "Letting every service reach in and read every table.",
        ],
    ),
    "queue": (
        "A buffer between parts of the system: producers add messages, workers take them when they are ready.",
        [
            ("Direct calls between services", "the work is quick and the caller needs the answer now"),
            ("Event streaming such as Kafka", "you need to replay history or have many independent consumers"),
        ],
        [
            "Queue growing without anyone noticing: alert on age of the oldest message.",
            "Assuming messages arrive once and in order.",
        ],
    ),
    "storage": (
        "Object storage for large files such as images, video, documents and backups, accessed by name over HTTP.",
        [
            ("Store files in the database", "files are tiny and must be in the same transaction as other data"),
            ("A shared file system", "software expects ordinary file paths"),
        ],
        [
            "Public buckets by accident: block public access unless it is intended.",
            "Sending big uploads through your servers instead of directly to storage with a temporary signed link.",
        ],
    ),
    "search": (
        "A search engine holding a searchable copy of your data for full-text queries, filters and ranking.",
        [
            ("Database full-text search", "data is small and the database already holds it"),
            ("Plain filtering in the database", "users only filter by exact values"),
        ],
        [
            "Treating it as the source of truth: it is a copy, rebuilt from the database.",
            "No plan for keeping the copy in step with the database.",
        ],
    ),
    "other": (
        "A supporting part of the design (monitoring, security or networking).",
        [],
        ["Adding it without anyone watching or acting on what it reports."],
    ),
}


def explain_component(arch: ArchitectureResult, reqs: Requirements, component_id: str) -> ExplainResponse:
    ctx = build_context(arch, reqs)
    component = ctx.view.by_id.get(component_id)
    if component is None:
        raise KeyError(component_id)
    role = ctx.roles[component.id]
    what, alternatives, pitfalls = KNOWLEDGE.get(role, KNOWLEDGE["other"])
    incoming, outgoing = neighbours(ctx, component.id)

    count = ctx.count(component)
    role_here = f"{component.name} is a {component.type.replace('_', ' ')} in this design"
    if role in {"api", "worker", "cache"}:
        role_here += f", running {count} cop{'y' if count == 1 else 'ies'}"
    if component.provider:
        role_here += f" on {component.provider}"
    role_here += "."
    if role == "database":
        engine = ctx.db_engine()
        if engine:
            role_here += f" It uses {engine}."
        if component.configuration.get("multi_az") is True:
            role_here += " It has a standby in another zone."
    if role == "api" and ctx.arch.connections:
        role_here += " It is where the application's own logic runs."

    text = " ".join([what, role_here, *pitfalls, *(a[0] for a in alternatives)])
    terms = [t for t in terms_in(text) if t in GLOSSARY][:10]
    return ExplainResponse(
        component_id=component.id,
        name=component.name,
        kind=component.type,
        what_it_is=what,
        role_here=role_here,
        receives_from=[c.name for c in incoming],
        sends_to=[c.name for c in outgoing],
        alternatives=[ExplainAlternative(name=n, choose_when=w) for n, w in alternatives],
        pitfalls=pitfalls,
        terms=terms,
    )
