"""Draft data model: the main entities, their fields and relations, which store each belongs in, an ER diagram
(Mermaid) and CREATE TABLE statements for a relational database.

Entities come from templates for common kinds of application and are placed in the stores the design actually
has (relational database, cache, object storage, search). A starting point to refine, not a finished schema.
"""

from __future__ import annotations

import re

from app.schemas.models import ArchitectureResult, Requirements
from app.schemas.toolkit import DataModelResponse, Entity, EntityField, Relation
from app.services.toolkit.common import Context, build_context

RELATIONAL_ENGINES = {"postgres", "mysql", "mariadb"}


def field(spec: str) -> EntityField:
    """'user_id:uuid:fk=User' / 'email:text:unique' / 'bio:text:null' / 'id:uuid:pk' -> EntityField."""
    parts = spec.split(":")
    name, kind, flags = parts[0], parts[1], parts[2:]
    key, nullable, references = "", False, ""
    for flag in flags:
        if flag == "pk":
            key = "pk"
        elif flag == "unique":
            key = "unique"
        elif flag == "null":
            nullable = True
        elif flag.startswith("fk="):
            references = flag[3:]  # a field can be a foreign key and part of the primary key
    return EntityField(name=name, type=kind, key=key, nullable=nullable, references=references)


def ent(
    name: str, description: str, store: str, fields: list[str], indexes: list[str] | None = None, note: str = ""
) -> dict:
    return {
        "name": name,
        "description": description,
        "store": store,
        "fields": fields,
        "indexes": indexes or [],
        "note": note,
    }


ID = "id:uuid:pk"
CREATED = "created_at:timestamp"

USER = ent(
    "User",
    "A person with an account.",
    "relational",
    [ID, "email:text:unique", "password_hash:text", "name:text", CREATED],
    note="Email and name are personal data: encrypt backups and plan for deletion requests.",
)
SESSION = ent(
    "Session",
    "A signed-in session (or token record).",
    "cache",
    ["token:text:pk", "user_id:uuid:fk=User", "expires_at:timestamp"],
    note="Short-lived and looked up on every request: a cache with a time-to-live fits better than a table.",
)

TEMPLATES: dict[str, list[dict]] = {
    "ecommerce": [
        USER,
        SESSION,
        ent(
            "Address",
            "Where to ship.",
            "relational",
            [ID, "user_id:uuid:fk=User", "line1:text", "city:text", "postal_code:text", "country:text"],
        ),
        ent(
            "Category",
            "A group of products.",
            "relational",
            [ID, "name:text:unique", "parent_id:uuid:fk=Category:null"],
        ),
        ent(
            "Product",
            "Something for sale.",
            "relational",
            [
                ID,
                "category_id:uuid:fk=Category",
                "name:text",
                "description:text",
                "price:decimal",
                "currency:text",
                "stock:int",
                "image_url:text:null",
                CREATED,
            ],
            ["category_id", "name"],
            "Copy name and description into the search index; keep images in object storage and store only the URL here.",
        ),
        ent(
            "CartItem",
            "An item a user means to buy.",
            "cache",
            ["user_id:uuid:fk=User:pk", "product_id:uuid:fk=Product:pk", "quantity:int"],
            note="A cart changes constantly and is disposable until checkout, so it can live in the cache.",
        ),
        ent(
            "Order",
            "A completed checkout.",
            "relational",
            [ID, "user_id:uuid:fk=User", "status:text", "total:decimal", "currency:text", CREATED],
            ["user_id", "created_at"],
        ),
        ent(
            "OrderItem",
            "One line of an order, with the price at the time.",
            "relational",
            [ID, "order_id:uuid:fk=Order", "product_id:uuid:fk=Product", "quantity:int", "unit_price:decimal"],
            note="Copy the price here: changing a product's price later must not change old orders.",
        ),
        ent(
            "Payment",
            "Money taken for an order.",
            "relational",
            [ID, "order_id:uuid:fk=Order", "provider_ref:text:unique", "status:text", "amount:decimal", CREATED],
            note="Store the provider's reference, never card numbers.",
        ),
        ent(
            "Review",
            "A customer's opinion of a product.",
            "relational",
            [ID, "product_id:uuid:fk=Product", "user_id:uuid:fk=User", "rating:int", "body:text", CREATED],
            ["product_id"],
        ),
    ],
    "social": [
        USER,
        SESSION,
        ent(
            "Follow",
            "Who follows whom.",
            "relational",
            ["follower_id:uuid:fk=User:pk", "followee_id:uuid:fk=User:pk", CREATED],
            ["followee_id"],
            "Queried both ways (my followers, who I follow): keep an index in each direction.",
        ),
        ent(
            "Post",
            "Something a user published.",
            "relational",
            [ID, "author_id:uuid:fk=User", "body:text", "media_url:text:null", CREATED],
            ["author_id", "created_at"],
        ),
        ent(
            "Like",
            "A user liking a post.",
            "relational",
            ["post_id:uuid:fk=Post:pk", "user_id:uuid:fk=User:pk", CREATED],
        ),
        ent(
            "Comment",
            "A reply on a post.",
            "relational",
            [ID, "post_id:uuid:fk=Post", "user_id:uuid:fk=User", "body:text", CREATED],
            ["post_id"],
        ),
        ent(
            "FeedEntry",
            "A precomputed timeline row.",
            "cache",
            ["user_id:uuid:fk=User:pk", "post_id:uuid:fk=Post:pk", "score:int"],
            note="Built when someone posts (fan-out on write) so reading a feed is one lookup.",
        ),
    ],
    "messaging": [
        USER,
        SESSION,
        ent("Conversation", "A chat between members.", "relational", [ID, "kind:text", CREATED]),
        ent(
            "Member",
            "A user in a conversation.",
            "relational",
            ["conversation_id:uuid:fk=Conversation:pk", "user_id:uuid:fk=User:pk", "last_read_at:timestamp:null"],
            ["user_id"],
        ),
        ent(
            "Message",
            "One message.",
            "relational",
            [
                ID,
                "conversation_id:uuid:fk=Conversation",
                "sender_id:uuid:fk=User",
                "body:text",
                "client_id:text:unique",
                CREATED,
            ],
            ["conversation_id", "created_at"],
            "Append-only and read newest-first: partition by conversation. client_id makes retries safe.",
        ),
        ent(
            "Presence",
            "Who is online right now.",
            "cache",
            ["user_id:uuid:fk=User:pk", "last_seen_at:timestamp"],
            note="Expires on its own; never needs to be durable.",
        ),
    ],
    "video": [
        USER,
        SESSION,
        ent(
            "Video",
            "A video and its processing state.",
            "relational",
            [
                ID,
                "owner_id:uuid:fk=User",
                "title:text",
                "description:text",
                "status:text",
                "duration_seconds:int:null",
                "storage_key:text",
                CREATED,
            ],
            ["owner_id"],
        ),
        ent(
            "VideoFile",
            "The raw upload and each encoded rendition.",
            "object storage",
            ["storage_key:text:pk", "video_id:uuid:fk=Video", "rendition:text"],
            note="The files themselves live in object storage; the database only keeps the key.",
        ),
        ent(
            "WatchProgress",
            "Where a viewer stopped.",
            "relational",
            ["video_id:uuid:fk=Video:pk", "user_id:uuid:fk=User:pk", "seconds:int", "updated_at:timestamp"],
        ),
        ent(
            "VideoIndex",
            "Searchable title and description.",
            "search",
            ["video_id:uuid:fk=Video:pk", "title:text", "description:text"],
        ),
    ],
    "iot": [
        USER,
        ent(
            "Device",
            "A connected device.",
            "relational",
            [ID, "owner_id:uuid:fk=User", "name:text", "model:text", "status:text", "last_seen_at:timestamp:null"],
            ["owner_id"],
        ),
        ent(
            "Reading",
            "One measurement from a device.",
            "relational",
            ["device_id:uuid:fk=Device:pk", "recorded_at:timestamp:pk", "metric:text:pk", "value:decimal"],
            ["recorded_at"],
            "Huge and append-only: partition by time, and consider a time-series database. Roll old data up into hourly averages.",
        ),
        ent(
            "AlertRule",
            "A condition worth telling someone about.",
            "relational",
            [
                ID,
                "owner_id:uuid:fk=User",
                "device_id:uuid:fk=Device:null",
                "metric:text",
                "condition:text",
                "threshold:decimal",
            ],
        ),
        ent(
            "Alert",
            "A rule that fired.",
            "relational",
            [
                ID,
                "rule_id:uuid:fk=AlertRule",
                "device_id:uuid:fk=Device",
                "triggered_at:timestamp",
                "resolved_at:timestamp:null",
            ],
            ["rule_id"],
        ),
    ],
    "booking": [
        USER,
        SESSION,
        ent(
            "Listing",
            "Something that can be booked.",
            "relational",
            [ID, "owner_id:uuid:fk=User", "title:text", "location:text", "price:decimal", CREATED],
            ["location"],
        ),
        ent(
            "Slot",
            "A bookable time and its capacity.",
            "relational",
            [ID, "listing_id:uuid:fk=Listing", "starts_at:timestamp", "ends_at:timestamp", "capacity:int"],
            ["listing_id", "starts_at"],
            "Lock or use a conditional update when booking, so two people cannot take the last place.",
        ),
        ent(
            "Booking",
            "A reservation.",
            "relational",
            [ID, "user_id:uuid:fk=User", "slot_id:uuid:fk=Slot", "status:text", CREATED],
            ["user_id", "slot_id"],
        ),
        ent(
            "Payment",
            "Money taken for a booking.",
            "relational",
            [ID, "booking_id:uuid:fk=Booking", "provider_ref:text:unique", "status:text", "amount:decimal"],
            note="Store the provider's reference, never card numbers.",
        ),
    ],
    "generic": [
        USER,
        SESSION,
        ent(
            "Item",
            "The main thing the application manages. Rename it to match your application.",
            "relational",
            [ID, "owner_id:uuid:fk=User", "name:text", "data:json:null", CREATED],
            ["owner_id"],
        ),
    ],
}

PG_TYPES = {
    "uuid": "UUID",
    "text": "TEXT",
    "int": "INTEGER",
    "decimal": "NUMERIC(12,2)",
    "bool": "BOOLEAN",
    "timestamp": "TIMESTAMPTZ",
    "json": "JSONB",
}
MY_TYPES = {
    "uuid": "CHAR(36)",
    "text": "TEXT",
    "int": "INT",
    "decimal": "DECIMAL(12,2)",
    "bool": "BOOLEAN",
    "timestamp": "DATETIME",
    "json": "JSON",
}


def table_name(entity: str) -> str:
    snake = re.sub(r"(?<!^)(?=[A-Z])", "_", entity).lower()
    if snake.endswith("y") and not snake.endswith(("ay", "ey", "oy", "uy")):
        return snake[:-1] + "ies"
    if snake.endswith(("s", "x", "ch", "sh")):
        return snake + "es"
    return snake + "s"


def _store_label(ctx: Context, logical: str) -> tuple[str, str]:
    """(where this entity goes in this design, a note if the design lacks the store)."""
    engine = ctx.db_engine()
    db = ctx.first("database")
    if logical == "relational":
        if not db:
            return "relational database (none in the design)", "The design has no database: add one to hold this."
        if engine in RELATIONAL_ENGINES or engine == "":
            return f"relational database ({db.name})", ""
        return (
            f"document store ({db.name})",
            f"{engine} is not relational: model this as documents and skip the SQL below.",
        )
    if logical == "cache":
        cache = ctx.first("cache")
        if cache:
            return f"cache ({cache.name})", ""
        return (
            "relational database (no cache in the design)",
            "Without a cache this would also live in the database, with an expiry job.",
        )
    if logical == "object storage":
        storage = ctx.first("storage")
        if storage:
            return f"object storage ({storage.name})", ""
        return "object storage (none in the design)", "The design has no object storage: add a bucket for large files."
    search = ctx.first("search")
    if search:
        return f"search index ({search.name})", ""
    return "search index (none in the design)", "Without a search component, use the database's text search for now."


def _mermaid(entities: list[Entity], relations: list[Relation]) -> str:
    lines = ["erDiagram"]
    for r in relations:
        arrow = "}o--o{" if r.kind == "many-to-many" else "||--o{"
        lines.append(f'    {r.source.upper()} {arrow} {r.target.upper()} : "{r.via}"')
    for e in entities:
        lines.append(f"    {e.name.upper()} {{")
        for f in e.fields:
            tags = [
                t
                for t in (
                    "PK" if f.key == "pk" else "",
                    "FK" if f.references else "",
                    "UK" if f.key == "unique" else "",
                )
                if t
            ]
            lines.append(f"        {f.type} {f.name}" + (f" {', '.join(tags)}" if tags else ""))
        lines.append("    }")
    return "\n".join(lines)


def _sql(entities: list[Entity], dialect: str) -> str:
    types = PG_TYPES if dialect == "postgres" else MY_TYPES
    now = "now()" if dialect == "postgres" else "CURRENT_TIMESTAMP"
    relational = {e.name: e for e in entities if e.store.startswith("relational")}
    if not relational:
        return ""

    def column_type(f: EntityField) -> str:
        if (
            dialect == "mysql"
            and f.type == "text"
            and (f.key in {"unique", "pk"} or f.references or f.name.endswith("_id"))
        ):
            return "VARCHAR(255)"
        return types[f.type]

    # parents before children, so every REFERENCES points at an existing table
    ordered: list[str] = []
    pending = dict(relational)
    while pending:
        ready = [
            n
            for n, e in pending.items()
            if all(
                f.references in ordered or f.references == n or f.references not in relational
                for f in e.fields
                if f.references
            )
        ]
        if not ready:
            ready = list(pending)[:1]  # a reference cycle: break it at the first table
        for n in ready:
            ordered.append(n)
            del pending[n]

    out = [f"-- Draft schema for {dialect}. Review types, constraints and indexes before using it.", ""]
    for name in ordered:
        e = relational[name]
        table = table_name(name)
        cols = []
        pks = [f.name for f in e.fields if f.key == "pk"]
        for f in e.fields:
            parts = [f"    {f.name} {column_type(f)}"]
            if len(pks) == 1 and f.key == "pk":
                parts.append("PRIMARY KEY")
            elif not f.nullable:
                parts.append("NOT NULL")
            if f.key == "unique":
                parts.append("UNIQUE")
            if f.type == "timestamp" and f.name == "created_at":
                parts.append(f"DEFAULT {now}")
            if f.references in relational:
                parts.append(f"REFERENCES {table_name(f.references)}(id)")
            cols.append(" ".join(parts))
        if len(pks) > 1:
            cols.append(f"    PRIMARY KEY ({', '.join(pks)})")
        out.append(f"CREATE TABLE IF NOT EXISTS {table} (\n" + ",\n".join(cols) + "\n);")
        indexed = {f.name for f in e.fields if f.references and not (f.key == "pk" and len(pks) == 1)} | set(e.indexes)
        for column in sorted(indexed):
            out.append(
                f"CREATE INDEX IF NOT EXISTS idx_{table}_{column} ON {table} ({column});"
                if dialect == "postgres"
                else f"CREATE INDEX idx_{table}_{column} ON {table} ({column});"
            )
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def design_data_model(arch: ArchitectureResult, reqs: Requirements) -> DataModelResponse:
    ctx = build_context(arch, reqs)
    engine = ctx.db_engine()
    dialect = (
        "mysql" if engine in {"mysql", "mariadb"} else "postgres" if engine in RELATIONAL_ENGINES | {""} else "none"
    )

    entities: list[Entity] = []
    notes: list[str] = []
    for spec in TEMPLATES[ctx.domain]:
        place, store_note = _store_label(ctx, spec["store"])
        entities.append(
            Entity(
                name=spec["name"],
                description=spec["description"],
                store=place,
                fields=[field(f) for f in spec["fields"]],
                indexes=spec["indexes"],
                note=" ".join(x for x in (spec["note"], store_note) if x),
            )
        )

    relations: list[Relation] = []
    for e in entities:
        refs = [f for f in e.fields if f.references]
        for f in refs:
            relations.append(Relation(source=f.references, target=e.name, kind="one-to-many", via=f.name))
        # A table whose primary key is two references is the link between two entities (many-to-many).
        if len(refs) == 2 and all(f.key == "pk" for f in refs):
            relations.append(
                Relation(source=refs[0].references, target=refs[1].references, kind="many-to-many", via=e.name)
            )

    if dialect == "none":
        notes.append(
            f"The database engine ({engine}) is not relational, so no SQL is generated. Treat each relational entity as a document or item and pick a partition key."
        )
    elif not ctx.first("database"):
        notes.append("The design has no database, so the SQL shows the schema you would need to add one for.")
    notes += [
        "Use UUIDs or time-ordered ids for primary keys: they can be generated by any server without coordination.",
        "Store money as an exact decimal, never a float. Store every timestamp in UTC.",
        "Index every foreign key and every column you filter or sort by; check the plans with real data before adding more.",
        "If one table will outgrow a single database (see the capacity estimate), choose a shard key now, usually the owner's id, and avoid queries that join across shards.",
    ]
    if ctx.domain == "generic":
        notes.insert(
            0,
            "The application type was not recognised, so this is a generic model. Describe the application in the requirements for a closer fit.",
        )

    sql_dialect = dialect if dialect != "none" else "postgres"
    return DataModelResponse(
        domain=ctx.domain,
        dialect=dialect,
        entities=entities,
        relations=relations,
        mermaid=_mermaid(entities, relations),
        sql=_sql(entities, sql_dialect) if dialect != "none" else "",
        notes=notes,
    )
