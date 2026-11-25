"""Draft REST API: the endpoints a design like this would need, grouped, with who may call them and which
component serves them, plus an OpenAPI 3 skeleton to start from.

The endpoints come from templates for common kinds of application (shop, social, chat, video, IoT, booking, or a
generic create/read/update/delete API), adjusted to the components in the design. They are a starting point to
argue about, not a finished contract.
"""

from __future__ import annotations

import re

from app.schemas.models import ArchitectureResult, Requirements
from app.schemas.toolkit import ApiDesignResponse, ApiEndpoint, ApiGroup
from app.services.toolkit.common import Context, build_context, slug

BASE_PATH = "/v1"


def ep(method: str, path: str, summary: str, auth: str = "user", **kw) -> dict:
    return {"method": method, "path": path, "summary": summary, "auth": auth, **kw}


AUTH_GROUP = (
    "Authentication",
    "Sign up, sign in and sessions.",
    [
        ep("POST", "/auth/register", "Create an account", "public"),
        ep("POST", "/auth/login", "Sign in and receive tokens", "public"),
        ep("POST", "/auth/refresh", "Exchange a refresh token for a new access token", "public"),
        ep("POST", "/auth/logout", "End the session"),
        ep("GET", "/me", "The signed-in user's profile"),
        ep("PATCH", "/me", "Update the signed-in user's profile", idempotent=True),
    ],
)

# group name, description, endpoints
TEMPLATES: dict[str, list[tuple[str, str, list[dict]]]] = {
    "ecommerce": [
        (
            "Products",
            "The catalogue.",
            [
                ep("GET", "/products", "List products", "public", paginated=True),
                ep("GET", "/products/{productId}", "Get one product", "public"),
                ep("GET", "/products/search", "Search products by text and filters", "public", paginated=True),
                ep("POST", "/products", "Add a product", "admin"),
                ep("PUT", "/products/{productId}", "Replace a product", "admin", idempotent=True),
                ep("DELETE", "/products/{productId}", "Remove a product", "admin", idempotent=True),
            ],
        ),
        (
            "Cart",
            "What the user intends to buy.",
            [
                ep("GET", "/cart", "Get the current cart"),
                ep("POST", "/cart/items", "Add an item"),
                ep("PATCH", "/cart/items/{itemId}", "Change an item's quantity", idempotent=True),
                ep("DELETE", "/cart/items/{itemId}", "Remove an item", idempotent=True),
            ],
        ),
        (
            "Orders",
            "Checkout and order history.",
            [
                ep(
                    "POST",
                    "/orders",
                    "Place an order from the cart",
                    note="Send an Idempotency-Key so retries never double-order.",
                ),
                ep("GET", "/orders", "List the user's orders", paginated=True),
                ep("GET", "/orders/{orderId}", "Get one order, with its status"),
                ep("POST", "/orders/{orderId}/cancel", "Cancel an order that has not shipped", idempotent=True),
            ],
        ),
        (
            "Payments",
            "Taking money safely.",
            [
                ep(
                    "POST",
                    "/payments",
                    "Start a payment for an order",
                    note="Idempotency-Key required. Never store card numbers.",
                ),
                ep("GET", "/payments/{paymentId}", "Get a payment's status"),
                ep("POST", "/payments/webhook", "Receive the payment provider's result", "service", idempotent=True),
            ],
        ),
        (
            "Reviews",
            "Customer feedback.",
            [
                ep("GET", "/products/{productId}/reviews", "List a product's reviews", "public", paginated=True),
                ep("POST", "/products/{productId}/reviews", "Write a review"),
            ],
        ),
    ],
    "social": [
        (
            "Profiles",
            "People and who they follow.",
            [
                ep("GET", "/users/{userId}", "Get a public profile", "public"),
                ep("POST", "/users/{userId}/follow", "Follow a user", idempotent=True),
                ep("DELETE", "/users/{userId}/follow", "Unfollow a user", idempotent=True),
                ep("GET", "/users/{userId}/followers", "List followers", "public", paginated=True),
            ],
        ),
        (
            "Posts",
            "What people publish.",
            [
                ep("POST", "/posts", "Create a post"),
                ep("GET", "/posts/{postId}", "Get a post", "public"),
                ep("DELETE", "/posts/{postId}", "Delete your post", idempotent=True),
                ep("POST", "/posts/{postId}/likes", "Like a post", idempotent=True),
                ep("GET", "/posts/{postId}/comments", "List comments", "public", paginated=True),
                ep("POST", "/posts/{postId}/comments", "Comment on a post"),
            ],
        ),
        (
            "Feed",
            "A personal timeline.",
            [
                ep(
                    "GET",
                    "/feed",
                    "The user's home feed",
                    paginated=True,
                    note="Cursor pagination: new posts arrive while scrolling.",
                ),
            ],
        ),
    ],
    "messaging": [
        (
            "Conversations",
            "Who is talking to whom.",
            [
                ep("GET", "/conversations", "List the user's conversations", paginated=True),
                ep("POST", "/conversations", "Start a conversation"),
                ep("GET", "/conversations/{conversationId}", "Get a conversation and its members"),
            ],
        ),
        (
            "Messages",
            "The messages themselves.",
            [
                ep(
                    "POST",
                    "/conversations/{conversationId}/messages",
                    "Send a message",
                    note="Client-generated id makes retries safe.",
                ),
                ep("GET", "/conversations/{conversationId}/messages", "Load message history", paginated=True),
                ep("PUT", "/conversations/{conversationId}/read", "Mark messages as read", idempotent=True),
            ],
        ),
        (
            "Presence",
            "Online status and live delivery.",
            [
                ep("PUT", "/presence", "Report that the user is online", idempotent=True),
                ep(
                    "GET",
                    "/ws",
                    "Open a WebSocket for live messages and typing indicators",
                    note="Not REST: described here so it is not forgotten.",
                ),
            ],
        ),
    ],
    "video": [
        (
            "Videos",
            "The catalogue and playback.",
            [
                ep("GET", "/videos", "List videos", "public", paginated=True),
                ep("GET", "/videos/{videoId}", "Get a video's details", "public"),
                ep(
                    "GET",
                    "/videos/{videoId}/stream-url",
                    "Get a signed playback URL",
                    note="Short-lived signed URLs keep content protected.",
                ),
                ep("PUT", "/videos/{videoId}/progress", "Save the viewer's position", idempotent=True),
            ],
        ),
        (
            "Uploads",
            "Getting new videos in.",
            [
                ep("POST", "/videos", "Start an upload and create the video record"),
                ep("POST", "/videos/{videoId}/upload-url", "Get a signed URL to upload the file directly to storage"),
                ep(
                    "POST",
                    "/videos/{videoId}/complete",
                    "Mark the upload finished and start processing",
                    idempotent=True,
                ),
            ],
        ),
    ],
    "iot": [
        (
            "Devices",
            "The fleet.",
            [
                ep("POST", "/devices", "Register a device", "admin"),
                ep("GET", "/devices", "List devices", paginated=True),
                ep("GET", "/devices/{deviceId}", "Get a device and its latest state"),
                ep("PATCH", "/devices/{deviceId}", "Change a device's settings", idempotent=True),
            ],
        ),
        (
            "Telemetry",
            "Readings from devices.",
            [
                ep(
                    "POST",
                    "/devices/{deviceId}/readings",
                    "Send readings (devices call this)",
                    "service",
                    note="Batch readings to cut request volume.",
                ),
                ep("GET", "/devices/{deviceId}/readings", "Query readings over a time range", paginated=True),
            ],
        ),
        (
            "Alerts",
            "Noticing problems.",
            [
                ep("GET", "/alerts", "List active alerts", paginated=True),
                ep("POST", "/alert-rules", "Create an alert rule"),
            ],
        ),
    ],
    "booking": [
        (
            "Availability",
            "What can be booked.",
            [
                ep("GET", "/availability", "Search availability by date and place", "public", paginated=True),
                ep("GET", "/listings/{listingId}", "Get one listing", "public"),
            ],
        ),
        (
            "Bookings",
            "Reserving and managing.",
            [
                ep("POST", "/bookings", "Make a booking", note="Idempotency-Key required; hold the slot while paying."),
                ep("GET", "/bookings", "List the user's bookings", paginated=True),
                ep("GET", "/bookings/{bookingId}", "Get a booking"),
                ep("POST", "/bookings/{bookingId}/cancel", "Cancel a booking", idempotent=True),
            ],
        ),
        (
            "Payments",
            "Taking money safely.",
            [
                ep("POST", "/payments", "Pay for a booking", note="Idempotency-Key required."),
                ep("POST", "/payments/webhook", "Receive the payment provider's result", "service", idempotent=True),
            ],
        ),
    ],
    "generic": [
        (
            "Items",
            "The main resource. Rename it to match your application.",
            [
                ep("GET", "/items", "List items", paginated=True),
                ep("POST", "/items", "Create an item"),
                ep("GET", "/items/{itemId}", "Get one item"),
                ep("PUT", "/items/{itemId}", "Replace an item", idempotent=True),
                ep("DELETE", "/items/{itemId}", "Delete an item", idempotent=True),
            ],
        ),
    ],
}

OPERATIONS_GROUP = (
    "Operations",
    "For load balancers and monitoring, not for end users.",
    [
        ep("GET", "/health", "Is the service up? (used by load-balancer health checks)", "public"),
        ep("GET", "/metrics", "Metrics for monitoring", "service"),
    ],
)


def _service_for(ctx: Context, group: str) -> str:
    """The component expected to serve a group: an auth component for sign-in, else the web server whose name
    matches the group best, else the first web server."""
    if group == "Authentication":
        auth = ctx.first("auth")
        if auth:
            return auth.name

    def words(text: str) -> set[str]:
        return {w.rstrip("s") for w in re.findall(r"[a-z]+", text.lower())}  # "Orders" matches "Order Service"

    best, best_score = None, 0
    for c in ctx.web:
        score = len(words(group) & words(c.name))
        if score > best_score:
            best, best_score = c, score
    chosen = best or (ctx.web[0] if ctx.web else None)
    return chosen.name if chosen else ""


def _groups(ctx: Context) -> list[tuple[str, str, list[dict]]]:
    groups = [AUTH_GROUP, *TEMPLATES[ctx.domain]]
    names = {g[0] for g in groups}
    if ctx.first("search") and "Search" not in names and ctx.domain != "ecommerce":
        groups.append(
            (
                "Search",
                "Full-text search backed by the search component.",
                [ep("GET", "/search", "Search across content", "public", paginated=True)],
            )
        )
    if ctx.first("storage") and ctx.domain != "video":
        groups.append(
            (
                "Files",
                "Uploads and downloads go straight to object storage with signed URLs.",
                [
                    ep("POST", "/files/upload-url", "Get a signed URL to upload a file"),
                    ep("GET", "/files/{fileId}/download-url", "Get a signed URL to download a file"),
                ],
            )
        )
    if ctx.first("queue", "worker"):
        groups.append(
            (
                "Jobs",
                "Work done in the background reports its progress here.",
                [
                    ep("GET", "/jobs/{jobId}", "Check a background job's status"),
                ],
            )
        )
    groups.append(OPERATIONS_GROUP)
    return groups


def _openapi(ctx: Context, groups: list[ApiGroup]) -> dict:
    paths: dict[str, dict] = {}
    for group in groups:
        for e in group.endpoints:
            operation: dict = {
                "tags": [group.name],
                "summary": e.summary,
                "operationId": f"{e.method.lower()}_{slug(e.path)}",
                "responses": {},
            }
            params = [
                {"name": n, "in": "path", "required": True, "schema": {"type": "string"}}
                for n in re.findall(r"{(\w+)}", e.path)
            ]
            if e.paginated:
                params += [
                    {
                        "name": "cursor",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "string"},
                        "description": "Opaque cursor from the previous page",
                    },
                    {
                        "name": "limit",
                        "in": "query",
                        "required": False,
                        "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
                    },
                ]
            if e.path.endswith("/search") or e.path == "/search":
                params.append({"name": "q", "in": "query", "required": False, "schema": {"type": "string"}})
            if e.method == "POST" and not e.idempotent and "Idempotency-Key" in e.note:
                params.append(
                    {"name": "Idempotency-Key", "in": "header", "required": True, "schema": {"type": "string"}}
                )
            if params:
                operation["parameters"] = params
            if e.method in {"POST", "PUT", "PATCH"}:
                operation["requestBody"] = {
                    "required": True,
                    "content": {
                        "application/json": {"schema": {"type": "object", "description": "TODO: define the fields"}}
                    },
                }
            success = {"GET": "200", "POST": "201", "PUT": "200", "PATCH": "200", "DELETE": "204"}[e.method]
            operation["responses"][success] = {"description": "Success"}
            operation["responses"]["400"] = {"description": "Invalid request"}
            if e.auth != "public":
                operation["security"] = [{"apiKey": []}] if e.auth == "service" else [{"bearerAuth": []}]
                operation["responses"]["401"] = {"description": "Missing or invalid credentials"}
                operation["responses"]["403"] = {"description": "Not allowed"}
            if e.auth == "admin":
                operation["x-required-role"] = "admin"
            if "{" in e.path:
                operation["responses"]["404"] = {"description": "Not found"}
            operation["responses"]["429"] = {"description": "Too many requests"}
            if e.note:
                operation["description"] = e.note
            paths.setdefault(e.path, {})[e.method.lower()] = operation
    return {
        "openapi": "3.0.3",
        "info": {
            "title": f"{ctx.arch.project_name} API",
            "version": "0.1.0",
            "description": "Skeleton generated by SysDesign AI. Define request and response schemas before using it.",
        },
        "servers": [{"url": f"https://api.example.com{BASE_PATH}"}],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"},
                "apiKey": {"type": "apiKey", "in": "header", "name": "X-API-Key"},
            }
        },
    }


def design_api(arch: ArchitectureResult, reqs: Requirements) -> ApiDesignResponse:
    ctx = build_context(arch, reqs)
    groups = [
        ApiGroup(
            name=name,
            description=description,
            endpoints=[ApiEndpoint(service=_service_for(ctx, name), **spec) for spec in specs],
        )
        for name, description, specs in _groups(ctx)
    ]
    notes = []
    if not ctx.web:
        notes.append("The design has no web-facing server, so no endpoint is assigned to a component yet.")
    if not ctx.first("auth"):
        notes.append(
            "There is no authentication component. Sign-in endpoints are listed but nothing in the design serves them; add an auth service."
        )
    if ctx.domain == "generic":
        notes.append(
            "The application type was not recognised, so this is a generic create/read/update/delete API. Describe the application in the requirements for a closer fit."
        )
    return ApiDesignResponse(
        domain=ctx.domain,
        base_path=BASE_PATH,
        conventions=[
            f"Version in the path ({BASE_PATH}), so a breaking change becomes /v2 without breaking old clients.",
            "JSON over HTTPS only. Use plural nouns for collections and the HTTP method for the action.",
            "List endpoints use cursor pagination (cursor and limit), never page numbers, so results stay stable while data changes.",
            "Writes that must not happen twice (orders, payments) take an Idempotency-Key header; PUT and DELETE are naturally repeatable.",
            "Authenticate with a short-lived bearer token. Check ownership on every request, not just login.",
            "Errors use one format (RFC 7807 problem+json) with a stable machine-readable code.",
            "Rate-limit per user and per IP, and say so with 429 and a Retry-After header.",
        ],
        groups=groups,
        openapi=_openapi(ctx, groups),
        notes=notes,
    )
