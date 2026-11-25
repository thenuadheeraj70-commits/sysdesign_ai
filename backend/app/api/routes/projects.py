import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import MAX_PROJECTS_PER_USER
from app.db import get_conn
from app.schemas.projects import ProjectIn, ProjectOut, ProjectPage, ProjectRename, ProjectSummary
from app.security import get_current_user
from app.services.versions import take_snapshot

PURGE_AFTER_DAYS = 30  # deleted projects stay in the trash this long, then are removed for good
TRASH_LIMIT = 50

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _out(row) -> ProjectOut:
    return ProjectOut(
        id=row["id"],
        name=row["name"],
        updated_at=row["updated_at"],
        deleted_at=row["deleted_at"],
        prompt=row["prompt"],
        architecture=json.loads(row["architecture"]),
        requirements=json.loads(row["requirements"]) if row["requirements"] else None,
        positions=json.loads(row["positions"]) if row["positions"] else None,
        variants=json.loads(row["variants"]) if row["variants"] else None,
        active_variant_id=row["active_variant"],
    )


def _clean_positions(positions, architecture) -> dict | None:
    """Keep only positions of components that exist, so stale entries never pile up."""
    if not positions:
        return None
    ids = {c.id for c in architecture.components}
    return {k: v.model_dump() for k, v in positions.items() if k in ids}


def _fields(body: ProjectIn):
    """The values stored for a project, in column order: name, prompt, architecture, requirements,
    positions, variants, active variant."""
    architecture, positions = body.architecture, body.positions
    variants_json = active = None
    if body.variants:
        variants_json = json.dumps(
            [
                {
                    "id": v.id,
                    "name": v.name,
                    "architecture": json.loads(v.architecture.model_dump_json()),
                    "positions": _clean_positions(v.positions, v.architecture),
                    "traffic_scale": v.traffic_scale,
                }
                for v in body.variants
            ]
        )
        active = body.active_variant_id
        # The plain architecture/positions columns always mirror the open variant (older clients read those).
        open_variant = next(v for v in body.variants if v.id == active)
        architecture, positions = open_variant.architecture, open_variant.positions
    return (
        body.name.strip(),
        body.prompt,
        architecture.model_dump_json(),
        body.requirements.model_dump_json() if body.requirements else None,
        json.dumps(_clean_positions(positions, architecture)) if positions else None,
        variants_json,
        active,
    )


def _purge_old_trash(conn, user_id: int) -> None:
    conn.execute(
        "DELETE FROM projects WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at < datetime('now', ?)",
        (user_id, f"-{PURGE_AFTER_DAYS} days"),
    )


def _check_room(conn, user_id: int) -> None:
    count = conn.execute(
        "SELECT COUNT(*) FROM projects WHERE user_id = ? AND deleted_at IS NULL", (user_id,)
    ).fetchone()[0]
    if count >= MAX_PROJECTS_PER_USER:
        raise HTTPException(409, f"You can save up to {MAX_PROJECTS_PER_USER} projects. Delete one first.")


def _owned(conn, project_id: int, user_id: int, include_deleted: bool = False):
    # Always filter by user_id: one user must never read or change another's project.
    sql = "SELECT * FROM projects WHERE id = ? AND user_id = ?"
    if not include_deleted:
        sql += " AND deleted_at IS NULL"
    row = conn.execute(sql, (project_id, user_id)).fetchone()
    if not row:
        raise HTTPException(404, "Project not found.")
    return row


def _like(text: str) -> str:
    """A LIKE pattern for 'contains text', with the wildcard characters escaped (escape char is '!')."""
    escaped = text.strip().replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return f"%{escaped}%"


@router.get("", response_model=ProjectPage)
def list_projects(
    q: str = Query("", max_length=100),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sort: Literal["updated", "name"] = "updated",
    user: dict = Depends(get_current_user),
):
    order = "name COLLATE NOCASE ASC, id ASC" if sort == "name" else "updated_at DESC, id DESC"
    where = "user_id = ? AND deleted_at IS NULL AND name LIKE ? ESCAPE '!'"
    args = (user["id"], _like(q))
    with get_conn() as conn:
        _purge_old_trash(conn, user["id"])
        total = conn.execute(f"SELECT COUNT(*) FROM projects WHERE {where}", args).fetchone()[0]
        rows = conn.execute(
            f"SELECT id, name, updated_at, deleted_at FROM projects WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
            (*args, limit, offset),
        ).fetchall()
    return ProjectPage(items=[ProjectSummary(**dict(r)) for r in rows], total=total, limit=limit, offset=offset)


@router.get("/trash", response_model=list[ProjectSummary])
def list_trash(user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        _purge_old_trash(conn, user["id"])
        rows = conn.execute(
            "SELECT id, name, updated_at, deleted_at FROM projects "
            "WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?",
            (user["id"], TRASH_LIMIT),
        ).fetchall()
    return [ProjectSummary(**dict(r)) for r in rows]


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(body: ProjectIn, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        _check_room(conn, user["id"])
        cur = conn.execute(
            "INSERT INTO projects (user_id, name, prompt, architecture, requirements, positions, "
            "variants, active_variant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user["id"], *_fields(body)),
        )
        take_snapshot(conn, cur.lastrowid, "Created")
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _out(row)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: int, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        return _out(_owned(conn, project_id, user["id"]))


@router.put("/{project_id}", response_model=ProjectOut)
def update_project(project_id: int, body: ProjectIn, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        _owned(conn, project_id, user["id"])
        conn.execute(
            "UPDATE projects SET name = ?, prompt = ?, architecture = ?, requirements = ?, "
            "positions = ?, variants = ?, active_variant = ?, updated_at = datetime('now') "
            "WHERE id = ? AND user_id = ?",
            (*_fields(body), project_id, user["id"]),
        )
        take_snapshot(conn, project_id, "Saved")
        row = _owned(conn, project_id, user["id"])
    return _out(row)


@router.patch("/{project_id}", response_model=ProjectSummary)
def rename_project(project_id: int, body: ProjectRename, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        _owned(conn, project_id, user["id"])
        conn.execute(
            "UPDATE projects SET name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
            (body.name.strip(), project_id, user["id"]),
        )
        row = _owned(conn, project_id, user["id"])
    return ProjectSummary(id=row["id"], name=row["name"], updated_at=row["updated_at"])


@router.post("/{project_id}/duplicate", response_model=ProjectOut, status_code=201)
def duplicate_project(project_id: int, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        row = _owned(conn, project_id, user["id"])
        _check_room(conn, user["id"])
        cur = conn.execute(
            "INSERT INTO projects (user_id, name, prompt, architecture, requirements, positions, "
            "variants, active_variant) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                user["id"],
                f"{row['name']} (copy)"[:120],
                row["prompt"],
                row["architecture"],
                row["requirements"],
                row["positions"],
                row["variants"],
                row["active_variant"],
            ),
        )
        take_snapshot(conn, cur.lastrowid, "Created (copy)")
        copy = conn.execute("SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone()
    return _out(copy)


@router.post("/{project_id}/restore", response_model=ProjectOut)
def restore_project(project_id: int, user: dict = Depends(get_current_user)):
    with get_conn() as conn:
        row = _owned(conn, project_id, user["id"], include_deleted=True)
        if row["deleted_at"] is not None:
            _check_room(conn, user["id"])
            conn.execute(
                "UPDATE projects SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
                (project_id, user["id"]),
            )
        row = _owned(conn, project_id, user["id"])
    return _out(row)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, permanent: bool = False, user: dict = Depends(get_current_user)):
    """Moves the project to the trash (kept 30 days). `permanent=true` removes it for good."""
    with get_conn() as conn:
        _owned(conn, project_id, user["id"], include_deleted=permanent)
        if permanent:
            conn.execute("DELETE FROM projects WHERE id = ? AND user_id = ?", (project_id, user["id"]))
        else:
            conn.execute(
                "UPDATE projects SET deleted_at = datetime('now') WHERE id = ? AND user_id = ?",
                (project_id, user["id"]),
            )
