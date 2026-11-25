"""Version history of a project: a snapshot is kept every time the project is saved, and an old one can be
compared with the current design or restored."""

from __future__ import annotations

import json
from typing import Any

from app.schemas.models import ArchitectureResult
from app.schemas.sharing import VersionDiff, VersionSummary
from app.services.ai_assist import describe_patch, patch_between

KEEP_VERSIONS = 30  # per project; the oldest are dropped
_FIELDS = ("name", "prompt", "architecture", "requirements", "positions", "variants", "active_variant")


def take_snapshot(conn: Any, project_id: int, label: str = "Saved") -> None:
    """Keep the project's current stored state as a new version, and drop the oldest beyond the limit."""
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    snapshot = json.dumps({f: row[f] for f in _FIELDS})
    conn.execute(
        "INSERT INTO project_versions (project_id, label, snapshot) VALUES (?, ?, ?)",
        (project_id, label[:80], snapshot),
    )
    conn.execute(
        "DELETE FROM project_versions WHERE project_id = ? AND id NOT IN "
        "(SELECT id FROM project_versions WHERE project_id = ? ORDER BY id DESC LIMIT ?)",
        (project_id, project_id, KEEP_VERSIONS),
    )


def _summary(row: Any) -> VersionSummary:
    data = json.loads(row["snapshot"])
    variants = json.loads(data["variants"]) if data.get("variants") else None
    components = json.loads(data["architecture"])["components"]
    return VersionSummary(
        id=row["id"],
        label=row["label"],
        created_at=row["created_at"],
        component_count=len(components),
        variant_count=len(variants) if variants else 1,
    )


def list_versions(conn: Any, project_id: int) -> list[VersionSummary]:
    rows = conn.execute(
        "SELECT * FROM project_versions WHERE project_id = ? ORDER BY id DESC", (project_id,)
    ).fetchall()
    return [_summary(r) for r in rows]


def get_version(conn: Any, project_id: int, version_id: int) -> Any | None:
    return conn.execute(
        "SELECT * FROM project_versions WHERE id = ? AND project_id = ?", (version_id, project_id)
    ).fetchone()


def compare(version_row: Any, current_row: Any) -> VersionDiff:
    """What changed between a saved version and the project as it is now, in words (from the old design's view:
    'added' means the current design has it and the old one did not)."""
    old = ArchitectureResult.model_validate_json(json.loads(version_row["snapshot"])["architecture"])
    new = ArchitectureResult.model_validate_json(current_row["architecture"])
    patch = patch_between(old, new, "Changes since this version")
    diff = describe_patch(old, patch)
    old_name = json.loads(version_row["snapshot"])["name"]
    renamed = f"{old_name} → {current_row['name']}" if old_name != current_row["name"] else ""
    metadata_changed = (old.project_name, old.description, old.assumptions) != (
        new.project_name,
        new.description,
        new.assumptions,
    )
    return VersionDiff(
        version=_summary(version_row),
        added=diff.added,
        removed=diff.removed,
        changed=diff.changed,
        renamed=renamed,
        identical=not (diff.added or diff.removed or diff.changed or renamed or metadata_changed),
    )


def restore(conn: Any, project_id: int, version_row: Any) -> None:
    """Make the project look like the version (the current state is kept as a version first)."""
    take_snapshot(conn, project_id, "Before restoring")
    data = json.loads(version_row["snapshot"])
    conn.execute(
        "UPDATE projects SET name = ?, prompt = ?, architecture = ?, requirements = ?, positions = ?, variants = ?, "
        "active_variant = ?, updated_at = datetime('now') WHERE id = ?",
        (*(data[f] for f in _FIELDS), project_id),
    )
    take_snapshot(conn, project_id, f"Restored version {version_row['id']}")
