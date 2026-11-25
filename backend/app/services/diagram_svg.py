"""The architecture as a picture: a standalone SVG (for download, embedding and the printable document) and as
Mermaid flowchart text. The layout is simple and deterministic: components are placed in columns by how far they
are from the entry point, and connections are drawn as curves with arrowheads."""

from __future__ import annotations

import re
from xml.sax.saxutils import escape

from app.schemas.models import ArchitectureResult
from app.services.sanitize import safe_text

NODE_W, NODE_H = 184, 58
GAP_X, GAP_Y, PAD = 90, 26, 28
TITLE_H = 40

# type -> (fill, stroke)
_COLORS = {
    "database": ("#e8f0fe", "#4a6fd1"),
    "cache": ("#fff4e0", "#c98a1b"),
    "compute": ("#e6f6ec", "#2f8f55"),
    "container": ("#e6f6ec", "#2f8f55"),
    "serverless": ("#e6f6ec", "#2f8f55"),
    "load_balancer": ("#f3e8ff", "#8b5cc6"),
    "api_gateway": ("#f3e8ff", "#8b5cc6"),
    "storage": ("#e0f4f8", "#2b8ba3"),
    "cdn": ("#e0f4f8", "#2b8ba3"),
    "queue": ("#fde8e8", "#c4524b"),
    "auth": ("#fff0f0", "#b4443c"),
    "security": ("#fff0f0", "#b4443c"),
}
_DEFAULT = ("#f2f4f7", "#7a8699")


def _layers(arch: ArchitectureResult) -> dict[str, int]:
    """Column of each component: the longest path from a component nothing sends to (cycles are cut)."""
    ids = [c.id for c in arch.components]
    incoming: dict[str, list[str]] = {i: [] for i in ids}
    for conn in arch.connections:
        incoming[conn.target].append(conn.source)
    layer: dict[str, int] = {}

    def depth(node: str, seen: frozenset[str]) -> int:
        if node in layer:
            return layer[node]
        best = 0
        for src in incoming[node]:
            if src not in seen:
                best = max(best, depth(src, seen | {node}) + 1)
        layer[node] = best
        return best

    for i in ids:
        depth(i, frozenset())
    return layer


def _mermaid_text(text: str, limit: int) -> str:
    """Label text for Mermaid: no quotes, pipes, or angle brackets (Mermaid can treat them as markup)."""
    return (
        _fit(text, limit)
        .replace('"', "'")
        .replace("|", "/")
        .replace("<", "\u2039")
        .replace(">", "\u203a")
        .replace("[", "(")
        .replace("]", ")")
    )


def _fit(text: str, limit: int) -> str:
    text = safe_text(text, 200)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def diagram_svg(arch: ArchitectureResult) -> str:
    """A complete, self-contained SVG document. All text is escaped."""
    layer = _layers(arch)
    columns: dict[int, list[str]] = {}
    for c in arch.components:
        columns.setdefault(layer[c.id], []).append(c.id)
    width_cols = (max(columns) + 1) if columns else 1
    tallest = max((len(v) for v in columns.values()), default=1)
    inner_h = tallest * NODE_H + (tallest - 1) * GAP_Y
    width = PAD * 2 + width_cols * NODE_W + (width_cols - 1) * GAP_X
    height = PAD * 2 + TITLE_H + inner_h

    pos: dict[str, tuple[float, float]] = {}
    for col, ids in columns.items():
        col_h = len(ids) * NODE_H + (len(ids) - 1) * GAP_Y
        top = PAD + TITLE_H + (inner_h - col_h) / 2
        for row, cid in enumerate(ids):
            pos[cid] = (PAD + col * (NODE_W + GAP_X), top + row * (NODE_H + GAP_Y))

    by_id = {c.id: c for c in arch.components}
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" '
        'font-family="Segoe UI, Helvetica, Arial, sans-serif">',
        f"<title>{escape(_fit(arch.project_name, 120))}</title>",
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" '
        'orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#55657d"/></marker></defs>',
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text x="{PAD}" y="{PAD + 12}" font-size="16" font-weight="700" fill="#14233a">'
        f"{escape(_fit(arch.project_name, 90))}</text>",
    ]
    for conn in arch.connections:
        x1, y1 = pos[conn.source][0] + NODE_W, pos[conn.source][1] + NODE_H / 2
        x2, y2 = pos[conn.target][0], pos[conn.target][1] + NODE_H / 2
        forward = x2 > x1
        if forward:
            dx = (x2 - x1) / 2
            path = f"M {x1} {y1} C {x1 + dx} {y1}, {x2 - dx} {y2}, {x2} {y2}"
        else:  # same column or a link back: leave from the bottom, enter at the top
            sx, sy = pos[conn.source][0] + NODE_W / 2, pos[conn.source][1] + NODE_H
            tx, ty = pos[conn.target][0] + NODE_W / 2, pos[conn.target][1]
            path = f"M {sx} {sy} C {sx} {sy + 40}, {tx} {ty - 40}, {tx} {ty}"
            x1, y1, x2, y2 = sx, sy, tx, ty
        parts.append(f'<path d="{path}" fill="none" stroke="#55657d" stroke-width="1.4" marker-end="url(#arrow)"/>')
        if conn.label:
            parts.append(
                f'<text x="{(x1 + x2) / 2}" y="{(y1 + y2) / 2 - 5}" font-size="10" fill="#55657d" '
                f'text-anchor="middle" paint-order="stroke" stroke="#ffffff" stroke-width="3">'
                f"{escape(_fit(conn.label, 26))}</text>"
            )
    for cid, (x, y) in pos.items():
        c = by_id[cid]
        kind = re.sub(r"[^a-z0-9]+", "_", c.type.lower()).strip("_")
        fill, stroke = _COLORS.get(kind, _DEFAULT)
        parts.append(
            f'<rect x="{x}" y="{y}" width="{NODE_W}" height="{NODE_H}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/>'
            f'<text x="{x + NODE_W / 2}" y="{y + 24}" font-size="12.5" font-weight="600" fill="#14233a" '
            f'text-anchor="middle">{escape(_fit(c.name, 26))}</text>'
            f'<text x="{x + NODE_W / 2}" y="{y + 42}" font-size="10.5" fill="#55657d" text-anchor="middle">'
            f"{escape(_fit(f'{c.type} · {c.provider}', 30))}</text>"
        )
    parts.append("</svg>")
    return "\n".join(parts)


def _mermaid_id(index: int) -> str:
    return f"n{index}"


def diagram_mermaid(arch: ArchitectureResult) -> str:
    """The design as a Mermaid flowchart (left to right)."""
    ids = {c.id: _mermaid_id(i) for i, c in enumerate(arch.components)}
    lines = ["flowchart LR"]
    for c in arch.components:
        label = _mermaid_text(f"{c.name} ({c.type})", 60)
        lines.append(f'    {ids[c.id]}["{label}"]')
    for conn in arch.connections:
        label = _mermaid_text(conn.label, 40)
        arrow = f'-->|"{label}"|' if label else "-->"
        lines.append(f"    {ids[conn.source]} {arrow} {ids[conn.target]}")
    return "\n".join(lines) + "\n"
