"""What every toolkit tool needs to know about a design: what kind of application it is, and the role each
component plays."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.schemas.models import ArchitectureComponent, ArchitectureResult, Requirements
from app.services.recommendation_engine import View, instance_count, is_background, web_facing

# Words that suggest what the application does. The domain with the most hits wins; none means "generic".
DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "ecommerce": ["shop", "store", "ecommerce", "e-commerce", "checkout", "cart", "marketplace", "catalog", "retail"],
    "social": ["social", "feed", "timeline", "follow", "post", "community", "network"],
    "messaging": ["chat", "messag", "whatsapp", "slack", "conversation", "inbox"],
    "video": ["video", "stream", "netflix", "youtube", "media", "podcast", "playback"],
    "iot": ["iot", "sensor", "telemetry", "device", "fleet", "smart home"],
    "booking": ["booking", "reservation", "ride", "hotel", "ticket", "appointment", "travel", "schedule"],
}

# Words the generated text uses for the main read and write actions in each domain.
DOMAIN_VOCAB: dict[str, dict[str, str]] = {
    "ecommerce": {"read": "browse products", "write": "place an order", "resource": "orders"},
    "social": {"read": "load the feed", "write": "create a post", "resource": "posts"},
    "messaging": {"read": "load a conversation", "write": "send a message", "resource": "messages"},
    "video": {"read": "play a video", "write": "upload a video", "resource": "videos"},
    "iot": {"read": "view a device dashboard", "write": "send a reading", "resource": "readings"},
    "booking": {"read": "search availability", "write": "make a booking", "resource": "bookings"},
    "generic": {"read": "read data", "write": "save data", "resource": "items"},
}


def slug(text: str, sep: str = "_") -> str:
    return re.sub(r"[^a-z0-9]+", sep, text.lower()).strip(sep) or "item"


def detect_domain(arch: ArchitectureResult, reqs: Requirements) -> str:
    text = " ".join(
        [reqs.application_type, arch.project_name, arch.description, *reqs.notes, *[c.name for c in arch.components]]
    ).lower()
    scores = {d: sum(text.count(w) for w in words) for d, words in DOMAIN_KEYWORDS.items()}
    best = max(scores, key=lambda d: scores[d])
    return best if scores[best] > 0 else "generic"


def _type_key(component: ArchitectureComponent) -> str:
    return re.sub(r"[^a-z0-9]+", "_", component.type.lower()).strip("_")


@dataclass
class Context:
    arch: ArchitectureResult
    reqs: Requirements
    view: View
    domain: str
    web: list[ArchitectureComponent]
    roles: dict[str, str] = field(default_factory=dict)  # component id -> role

    def with_role(self, *roles: str) -> list[ArchitectureComponent]:
        return [c for c in self.arch.components if self.roles[c.id] in roles]

    def first(self, *roles: str) -> ArchitectureComponent | None:
        found = self.with_role(*roles)
        return found[0] if found else None

    @property
    def vocab(self) -> dict[str, str]:
        return DOMAIN_VOCAB[self.domain]

    def db_engine(self) -> str:
        """The first database's engine as a lowercase word ("postgres", "mysql", "mongodb"...), or ""."""
        db = self.first("database")
        if not db:
            return ""
        engine = str({str(k).lower(): v for k, v in db.configuration.items()}.get("engine", "")).lower()
        return {"postgresql": "postgres", "aurora": "postgres"}.get(engine, engine)

    def count(self, component: ArchitectureComponent) -> int:
        return max(1, round(instance_count(component) or 1))


def role_of(view: View, component: ArchitectureComponent, web_ids: set[str]) -> str:
    """The part a component plays: client-facing edge, app server, store..., used by every tool."""
    kind = _type_key(component)
    category = view.category[component.id]
    if kind == "cdn":
        return "cdn"
    if kind == "api_gateway" or category == "load_balancer":
        return "entry"
    if kind == "auth":
        return "auth"
    if kind == "queue":
        return "queue"
    if kind == "search":
        return "search"
    if kind in {"monitoring", "security", "network"}:
        return "other"
    if category == "database":
        return "database"
    if category == "cache":
        return "cache"
    if category == "storage":
        return "storage"
    if category == "compute":
        return "api" if component.id in web_ids else "worker"
    return "other"


def build_context(arch: ArchitectureResult, reqs: Requirements) -> Context:
    view = View(arch)
    web = web_facing(view)
    web_ids = {c.id for c in web}
    ctx = Context(arch=arch, reqs=reqs, view=view, domain=detect_domain(arch, reqs), web=web)
    ctx.roles = {c.id: role_of(view, c, web_ids) for c in arch.components}
    return ctx


def neighbours(ctx: Context, component_id: str) -> tuple[list[ArchitectureComponent], list[ArchitectureComponent]]:
    """(components that send to this one, components this one sends to)."""
    incoming, outgoing = [], []
    for conn in ctx.arch.connections:
        if conn.target == component_id and conn.source in ctx.view.by_id:
            incoming.append(ctx.view.by_id[conn.source])
        if conn.source == component_id and conn.target in ctx.view.by_id:
            outgoing.append(ctx.view.by_id[conn.target])
    return incoming, outgoing


def is_worker(ctx: Context, component: ArchitectureComponent) -> bool:
    return is_background(ctx.view, component)


def pct(value: float, digits: int = 2) -> str:
    return f"{value:.{digits}f}%"


def human(n: float, digits: int = 1) -> str:
    """12345678 -> '12.3 million', for the sentences the tools write."""
    for limit, word in ((1e12, "trillion"), (1e9, "billion"), (1e6, "million"), (1e3, "thousand")):
        if abs(n) >= limit:
            return f"{n / limit:.{digits}f} {word}"
    return f"{n:.{digits}f}".rstrip("0").rstrip(".")


def md(text: object) -> str:
    """One line of text safe to put in Markdown: HTML and Markdown characters are escaped."""
    return re.sub(r"([\\`*_\[\]<>|])", r"\\\1", " ".join(str(text).split()))


def some(component: ArchitectureComponent | None) -> ArchitectureComponent:
    """A component that a check has already shown to exist (narrows the type for mypy)."""
    if component is None:
        raise ValueError("expected a component")
    return component
