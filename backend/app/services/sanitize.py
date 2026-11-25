"""Cleaning text that came from the AI (or from a user prompt echoed by it) before it is stored or put into
generated Terraform, YAML and Markdown. Control characters and line breaks are how hostile text escapes a comment
or a string in those formats, so they are removed at the door."""

from __future__ import annotations

import re
from typing import Any

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ‪-‮⁦-⁩]")


def safe_text(value: Any, limit: int = 300, default: str = "") -> str:
    """One line of plain text: no control or direction-override characters, single spaces, at most `limit` long."""
    if not isinstance(value, str):
        return default
    text = " ".join(_CONTROL.sub(" ", value).split())
    return text[:limit].strip() or default


def safe_config(value: Any, depth: int = 0) -> Any:
    """A configuration value with every string cleaned (keys too); deep or odd values are dropped."""
    if depth > 3:
        return None
    if isinstance(value, str):
        return safe_text(value, 500)
    if isinstance(value, bool | int | float) or value is None:
        return value
    if isinstance(value, list):
        return [safe_config(v, depth + 1) for v in value[:50]]
    if isinstance(value, dict):
        return {
            safe_text(str(k), 100): safe_config(v, depth + 1)
            for k, v in list(value.items())[:50]
            if safe_text(str(k), 100)
        }
    return None
