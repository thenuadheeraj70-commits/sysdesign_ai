"""Component catalog loaded from data/components_catalog.json (single source of truth)."""

import json
import re
from pathlib import Path

_FILE = Path(__file__).resolve().parent.parent / "data" / "components_catalog.json"
with open(_FILE, encoding="utf-8") as _f:
    CATALOG = json.load(_f)

SUPPORTED_TYPES: list[str] = CATALOG["supported_types"]
PROVIDERS: list[str] = CATALOG["providers"]
# Types that must never be reclassified from their name (a "queue" named "... Service" is not compute).
NON_CORE_TYPES: set[str] = set(CATALOG["non_core_types"])


def is_non_core_type(component_type: str) -> bool:
    return re.sub(r"[^a-z0-9]+", "_", component_type.lower()).strip("_") in NON_CORE_TYPES
