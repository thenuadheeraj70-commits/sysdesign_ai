"""Apply an ArchitecturePatch (the "fix" attached to a recommendation) to an architecture."""

from app.schemas.models import ArchitecturePatch, ArchitectureResult


def free_id(base: str, taken: set[str]) -> str:
    """base, or base-2, base-3 ... whichever is not taken yet."""
    candidate, n = base, 2
    while candidate in taken:
        candidate, n = f"{base}-{n}", n + 1
    return candidate


def apply_patch(architecture: ArchitectureResult, patch: ArchitecturePatch) -> ArchitectureResult:
    """Return a new, validated architecture. Raises ValueError if the patch no longer fits."""
    data = architecture.model_dump()
    by_id = {c["id"]: c for c in data["components"]}

    gone = set(patch.remove_components)
    missing = gone - by_id.keys()
    if missing:
        raise ValueError(f"Component '{sorted(missing)[0]}' no longer exists, so this fix can't be applied.")
    if gone:
        data["components"] = [c for c in data["components"] if c["id"] not in gone]
        data["connections"] = [c for c in data["connections"] if c["source"] not in gone and c["target"] not in gone]
        by_id = {c["id"]: c for c in data["components"]}

    for update in patch.update_components:
        if update.id not in by_id:
            raise ValueError(f"Component '{update.id}' no longer exists, so this fix can't be applied.")
        by_id[update.id]["configuration"] = {**by_id[update.id]["configuration"], **update.configuration}

    for component in patch.add_components:
        if component.id in by_id:
            raise ValueError(f"A component with id '{component.id}' already exists.")
        entry = component.model_dump()
        data["components"].append(entry)
        by_id[component.id] = entry

    seen = {(c["source"], c["target"]) for c in data["connections"]}
    for conn in patch.add_connections:
        if (conn.source, conn.target) not in seen:
            seen.add((conn.source, conn.target))
            data["connections"].append(conn.model_dump())

    return ArchitectureResult.model_validate(data)  # re-checks ids and connection targets
