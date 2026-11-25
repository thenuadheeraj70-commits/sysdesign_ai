"""Taking designs out of the app and sharing them: downloads (document, diagram, cost CSV, design file), design
import, read-only share links, version history, and "download all my projects".

Share links are public by design: whoever has the link can read the design (and nothing else) until the owner
revokes it. Everything else here needs a login, and only ever touches the caller's own projects."""

from __future__ import annotations

import json
import re
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.db import get_conn
from app.rate_limit import RateLimiter
from app.schemas.models import AnalyzeRequest, ArchitectureResult, Requirements
from app.schemas.sharing import (
    ImportRequest,
    ImportResponse,
    SharedDesign,
    ShareStatus,
    VersionDiff,
    VersionList,
)
from app.schemas.toolkit import ToolkitRequest
from app.security import get_current_user
from app.services import export_doc, versions
from app.services.diagram_svg import diagram_mermaid, diagram_svg
from app.services.sanitize import safe_text

router = APIRouter(prefix="/api", tags=["sharing"])

_public_limiter = RateLimiter(120)  # per client address per minute, for the public share endpoints
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{20,64}$")
_CALC_ERRORS = (ValueError, OverflowError, ZeroDivisionError)


def _filename(title: str, extension: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()[:60] or "architecture"
    return f"{stem}.{extension}"


def _download(content: str, media_type: str, filename: str) -> Response:
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
    )


# ---------- downloads (no login needed: they only calculate on what is sent) ----------


@router.post("/export/document")
def export_document(request: AnalyzeRequest, format: str = Query("markdown", pattern="^(markdown|html)$")):
    """The design document as Markdown, or as a printable HTML page (print it to save a PDF)."""
    try:
        doc = export_doc.build_document(request)
    except _CALC_ERRORS as exc:
        raise HTTPException(422, str(exc)) from exc
    if format == "html":
        return _download(export_doc.to_html(doc, request.architecture), "text/html", _filename(doc.title, "html"))
    return _download(export_doc.to_markdown(doc), "text/markdown", _filename(doc.title, "md"))


@router.post("/export/diagram")
def export_diagram(architecture: ArchitectureResult, format: str = Query("svg", pattern="^(svg|mermaid)$")):
    """The diagram as an SVG image or as Mermaid text."""
    if format == "mermaid":
        return _download(diagram_mermaid(architecture), "text/plain", _filename(architecture.project_name, "mmd"))
    return _download(diagram_svg(architecture), "image/svg+xml", _filename(architecture.project_name, "svg"))


@router.post("/export/cost-csv")
def export_cost_csv(request: AnalyzeRequest):
    """The cost table as a CSV file."""
    try:
        text = export_doc.cost_csv(request)
    except _CALC_ERRORS as exc:
        raise HTTPException(422, str(exc)) from exc
    return _download(text, "text/csv", _filename(request.architecture.project_name + " cost", "csv"))


@router.post("/export/design-file")
def export_design_file(request: ToolkitRequest):
    """The design as a JSON file that can be imported again."""
    text = json.dumps(export_doc.export_file(request.architecture, request.requirements), indent=2, ensure_ascii=False)
    return _download(text, "application/json", _filename(request.architecture.project_name, "sysdesign.json"))


@router.post("/import/design", response_model=ImportResponse)
def import_design(request: ImportRequest):
    """Check and clean a design file's contents. Nothing is stored: the app loads the result as a new design."""
    try:
        return export_doc.import_file(request.data)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


# ---------- all my projects ----------


@router.get("/projects/export-all")
def export_all_projects(user: dict = Depends(get_current_user)):
    """Every project the user has (including the trash) as one JSON file."""
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY id", (user["id"],)).fetchall()
    projects = []
    for r in rows:
        projects.append(
            {
                "name": r["name"],
                "prompt": r["prompt"],
                "created_at": r["created_at"],
                "updated_at": r["updated_at"],
                "deleted_at": r["deleted_at"],
                "architecture": json.loads(r["architecture"]),
                "requirements": json.loads(r["requirements"]) if r["requirements"] else None,
                "variants": json.loads(r["variants"]) if r["variants"] else None,
                "active_variant_id": r["active_variant"],
            }
        )
    payload = {
        "format": "sysdesign-ai-projects",
        "version": 1,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "email": user["email"],
        "projects": projects,
    }
    return _download(
        json.dumps(payload, indent=2, ensure_ascii=False), "application/json", "my-sysdesign-projects.json"
    )


# ---------- read-only share links ----------


def _owned_row(conn, project_id: int, user_id: int):
    row = conn.execute(
        "SELECT * FROM projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL", (project_id, user_id)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Project not found.")
    return row


def _status(token: str | None) -> ShareStatus:
    return ShareStatus(shared=bool(token), token=token, path=f"/?shared={token}" if token else None)


@router.get("/projects/{project_id}/share", response_model=ShareStatus)
def share_status(project_id: int, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        return _status(_owned_row(conn, project_id, user["id"])["share_token"])


@router.post("/projects/{project_id}/share", response_model=ShareStatus)
def create_share(project_id: int, user: dict = Depends(get_current_user)):
    """Turn on the read-only link (the same link is returned if it is already on)."""
    with get_conn() as conn:
        row = _owned_row(conn, project_id, user["id"])
        token = row["share_token"]
        if not token:
            token = secrets.token_urlsafe(24)
            conn.execute("UPDATE projects SET share_token = ? WHERE id = ?", (token, project_id))
    return _status(token)


@router.delete("/projects/{project_id}/share", response_model=ShareStatus)
def revoke_share(project_id: int, user: dict = Depends(get_current_user)):
    """Turn the link off. Anyone who had it can no longer open it; sharing again makes a new link."""
    with get_conn() as conn:
        _owned_row(conn, project_id, user["id"])
        conn.execute("UPDATE projects SET share_token = NULL WHERE id = ?", (project_id,))
    return _status(None)


def _shared_row(token: str, request: Request):
    if not _public_limiter.allow(request.client.host if request.client else "unknown"):
        raise HTTPException(429, "Too many requests. Please wait a minute.")
    if not _TOKEN.match(token):
        raise HTTPException(404, "This link does not exist or has been turned off.")
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM projects WHERE share_token = ? AND deleted_at IS NULL", (token,)).fetchone()
    if not row:
        raise HTTPException(404, "This link does not exist or has been turned off.")
    return row


@router.get("/shared/{token}", response_model=SharedDesign)
def shared_design(token: str, request: Request, response: Response):
    """The design behind a share link, read-only. No login."""
    row = _shared_row(token, request)
    architecture = ArchitectureResult.model_validate_json(row["architecture"])
    reqs = Requirements.model_validate_json(row["requirements"]) if row["requirements"] else Requirements()
    try:
        document = export_doc.build_document(AnalyzeRequest(architecture=architecture, requirements=reqs))
    except _CALC_ERRORS as exc:
        raise HTTPException(422, str(exc)) from exc
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Robots-Tag"] = "noindex"
    return SharedDesign(
        name=safe_text(row["name"], 200), updated_at=row["updated_at"], document=document, architecture=architecture
    )


@router.get("/shared/{token}/diagram.svg")
def shared_diagram(token: str, request: Request):
    """The shared diagram as an image, for embedding in documents and wikis (`<img src=...>`)."""
    row = _shared_row(token, request)
    svg = diagram_svg(ArchitectureResult.model_validate_json(row["architecture"]))
    return Response(
        content=svg,
        media_type="image/svg+xml",
        headers={
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        },
    )


# ---------- version history ----------


@router.get("/projects/{project_id}/versions", response_model=VersionList)
def list_versions(project_id: int, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        _owned_row(conn, project_id, user["id"])
        return VersionList(items=versions.list_versions(conn, project_id))


@router.get("/projects/{project_id}/versions/{version_id}/compare", response_model=VersionDiff)
def compare_version(project_id: int, version_id: int, user: dict = Depends(get_current_user)):
    """What has changed in the project since a saved version."""
    with get_conn() as conn:
        current = _owned_row(conn, project_id, user["id"])
        version = versions.get_version(conn, project_id, version_id)
        if not version:
            raise HTTPException(404, "Version not found.")
        return versions.compare(version, current)


@router.post("/projects/{project_id}/versions/{version_id}/restore")
def restore_version(project_id: int, version_id: int, user: dict = Depends(get_current_user)):
    """Put the project back to a saved version. The state before is kept as a version, so this can be undone."""
    with get_conn() as conn:
        _owned_row(conn, project_id, user["id"])
        version = versions.get_version(conn, project_id, version_id)
        if not version:
            raise HTTPException(404, "Version not found.")
        versions.restore(conn, project_id, version)
    return {"restored": version_id}
