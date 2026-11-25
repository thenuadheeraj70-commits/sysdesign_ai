"""Sequence diagrams: how a request travels through the components of the design, for the common flows
(read, sign in, write, upload, search). Built from the components that are actually there, so a design with a
queue shows the work handed off, and one without shows everything finishing before the answer.
"""

from __future__ import annotations

import re

from app.schemas.models import ArchitectureResult, Requirements
from app.schemas.toolkit import SequenceFlow, SequenceParticipant, SequenceResponse, SequenceStep
from app.services.toolkit.common import Context, build_context

ORDER = ["client", "cdn", "entry", "api", "auth", "cache", "database", "search", "queue", "worker", "storage"]


def _mermaid_text(text: str) -> str:
    """Text that cannot break Mermaid's syntax: letters, digits and a few harmless marks."""
    return re.sub(r"[^A-Za-z0-9 ()./,\-&+>]+", "", text).strip() or "-"


def to_mermaid(participants: list[SequenceParticipant], steps: list[SequenceStep]) -> str:
    alias = {p.id: f"p{i}" for i, p in enumerate(participants)}
    out = ["sequenceDiagram"]
    for p in participants:
        out.append(f"    participant {alias[p.id]} as {_mermaid_text(p.name)}")
    for s in steps:
        label = _mermaid_text(s.label)
        if s.kind == "call":
            out.append(f"    {alias[s.source]}->>{alias[s.target]}: {label}")
        elif s.kind == "return":
            out.append(f"    {alias[s.source]}-->>{alias[s.target]}: {label}")
        elif s.kind == "async":
            out.append(f"    {alias[s.source]}-){alias[s.target]}: {label}")
        elif s.kind == "note":
            span = alias[s.source] if s.source == s.target else f"{alias[s.source]},{alias[s.target]}"
            out.append(f"    Note over {span}: {label}")
        elif s.kind == "alt":
            out.append(f"    alt {label}")
        elif s.kind == "else":
            out.append(f"    else {label}")
        else:
            out.append("    end")
    return "\n".join(out)


class Flow:
    """Collects the steps and participants of one flow."""

    def __init__(self, ctx: Context):
        self.ctx = ctx
        self.steps: list[SequenceStep] = []
        self.used: set[str] = {"client"}
        self.ids = {"client": "client"}
        for role in ORDER[1:]:
            c = ctx.first(role)
            if c:
                self.ids[role] = c.id

    def has(self, role: str) -> bool:
        return role in self.ids

    def _use(self, *roles: str) -> None:
        self.used.update(roles)

    def call(self, a: str, b: str, label: str) -> None:
        self._use(a, b)
        self.steps.append(SequenceStep(kind="call", source=self.ids[a], target=self.ids[b], label=label))

    def back(self, a: str, b: str, label: str) -> None:
        self._use(a, b)
        self.steps.append(SequenceStep(kind="return", source=self.ids[a], target=self.ids[b], label=label))

    def later(self, a: str, b: str, label: str) -> None:
        self._use(a, b)
        self.steps.append(SequenceStep(kind="async", source=self.ids[a], target=self.ids[b], label=label))

    def note(self, a: str, b: str, text: str) -> None:
        self._use(a, b)
        self.steps.append(SequenceStep(kind="note", source=self.ids[a], target=self.ids[b], label=text))

    def block(self, kind: str, label: str = "") -> None:
        self.steps.append(SequenceStep(kind=kind, label=label))

    def chain(self) -> list[str]:
        """The roles a request passes before reaching the app server."""
        return [r for r in ("client", "cdn", "entry", "api") if self.has(r)]

    def request(self, label: str, cdn_note: bool = True) -> None:
        chain = self.chain()
        for a, b in zip(chain, chain[1:], strict=False):
            self.call(a, b, label if b == "api" or a == chain[0] else "forward")
        if cdn_note and self.has("cdn"):
            self.note("cdn", "cdn", "Static content is answered here without reaching the servers")

    def respond(self, label: str) -> None:
        chain = self.chain()
        for a, b in zip(reversed(chain), list(reversed(chain))[1:], strict=False):
            self.back(a, b, label)

    def finish(self, id_: str, title: str, description: str) -> SequenceFlow:
        participants = [
            SequenceParticipant(
                id=self.ids[role],
                name="Client" if role == "client" else self.ctx.view.by_id[self.ids[role]].name,
                kind=role,
            )
            for role in ORDER
            if role in self.used and role in self.ids
        ]
        return SequenceFlow(
            id=id_,
            title=title,
            description=description,
            available=True,
            participants=participants,
            steps=self.steps,
            mermaid=to_mermaid(participants, self.steps),
        )


def _unavailable(id_: str, title: str, description: str, reason: str) -> SequenceFlow:
    return SequenceFlow(id=id_, title=title, description=description, available=False, reason=reason)


def _read(ctx: Context) -> SequenceFlow:
    title = ctx.vocab["read"].capitalize()
    desc = "A user reads data. The cache answers when it can; otherwise the database does."
    f = Flow(ctx)
    if not f.has("api"):
        return _unavailable("read", title, desc, "The design has no web-facing server.")
    f.request("GET request")
    if f.has("cache"):
        f.call("api", "cache", "look up the data")
        f.block("alt", "cache hit")
        f.back("cache", "api", "cached data")
        f.block("else", "cache miss")
        if f.has("database"):
            f.call("api", "database", "query")
            f.back("database", "api", "rows")
        f.call("api", "cache", "store with an expiry time")
        f.block("end")
    elif f.has("database"):
        f.call("api", "database", "query")
        f.back("database", "api", "rows")
    else:
        f.note("api", "api", "The design has no data store to read from")
    f.respond("200 OK with the data")
    return f.finish("read", title, desc)


def _login(ctx: Context) -> SequenceFlow:
    title = "Sign in"
    desc = "A user proves who they are and receives a session."
    f = Flow(ctx)
    if not f.has("api"):
        return _unavailable("login", title, desc, "The design has no web-facing server.")
    f.request("POST /auth/login")
    if f.has("auth"):
        f.call("api", "auth", "verify credentials")
        if f.has("database") and any(
            {c.source, c.target} == {f.ids["auth"], f.ids["database"]} for c in ctx.arch.connections
        ):
            f.call("auth", "database", "read the user record")
            f.back("database", "auth", "user and password hash")
        f.back("auth", "api", "token")
    elif f.has("database"):
        f.call("api", "database", "look up the user and check the password hash")
        f.back("database", "api", "user record")
    if f.has("cache"):
        f.call("api", "cache", "store the session with an expiry time")
    f.respond("200 OK with a token")
    return f.finish("login", title, desc)


def _write(ctx: Context) -> SequenceFlow:
    title = ctx.vocab["write"].capitalize()
    desc = "A user changes data. Slow follow-up work is handed to a queue when the design has one."
    f = Flow(ctx)
    if not f.has("api") or not f.has("database"):
        return _unavailable("write", title, desc, "Needs a web-facing server and a database.")
    f.request("POST request with an Idempotency-Key")
    if f.has("auth"):
        f.call("api", "auth", "verify the token")
        f.back("auth", "api", "who the user is")
    f.call("api", "database", "write the record in a transaction")
    f.back("database", "api", "committed")
    if f.has("cache"):
        f.call("api", "cache", "remove stale cached data")
    if f.has("queue"):
        f.later("api", "queue", "enqueue follow-up work (email, stock, search index)")
        f.respond("202 Accepted: the rest happens in the background")
        f.note("queue", "queue", "Later, in the background")
        if f.has("worker"):
            f.later("queue", "worker", "deliver the job")
            f.call("worker", "database", "update the record")
            f.back("database", "worker", "done")
            if f.has("search"):
                f.later("worker", "search", "update the search index")
    else:
        f.note("api", "api", "No queue in the design: everything finishes before the answer")
        f.respond("201 Created")
    return f.finish("write", title, desc)


def _upload(ctx: Context) -> SequenceFlow:
    title = "Upload a file"
    desc = "Files go straight to object storage with a signed URL, so they never pass through the servers."
    f = Flow(ctx)
    if not f.has("api") or not f.has("storage"):
        return _unavailable("upload", title, desc, "Needs a web-facing server and object storage.")
    f.request("POST /files/upload-url")
    f.call("api", "storage", "create a signed upload URL")
    f.back("storage", "api", "signed URL")
    f.respond("signed URL")
    f.call("client", "storage", "PUT the file directly")
    f.back("storage", "client", "200 OK")
    if f.has("queue"):
        f.later("storage", "queue", "upload-finished event")
        if f.has("worker"):
            f.later("queue", "worker", "process the file")
            if f.has("database"):
                f.call("worker", "database", "save the result")
    return f.finish("upload", title, desc)


def _search(ctx: Context) -> SequenceFlow:
    title = "Search"
    desc = "A user searches. The search index finds matches; the database supplies the full records."
    f = Flow(ctx)
    if not f.has("api") or not f.has("search"):
        return _unavailable("search", title, desc, "Needs a web-facing server and a search component.")
    f.request("GET /search?q=...")
    f.call("api", "search", "query the index")
    f.back("search", "api", "matching ids and snippets")
    if f.has("database"):
        f.call("api", "database", "load the full records")
        f.back("database", "api", "rows")
    f.respond("200 OK with results")
    return f.finish("search", title, desc)


def design_sequences(arch: ArchitectureResult, reqs: Requirements) -> SequenceResponse:
    ctx = build_context(arch, reqs)
    return SequenceResponse(domain=ctx.domain, flows=[_read(ctx), _login(ctx), _write(ctx), _upload(ctx), _search(ctx)])
