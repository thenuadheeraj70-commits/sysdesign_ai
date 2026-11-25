"""Taking a design out of the app: a design document (data, Markdown, printable HTML), the cost table as CSV, and
reading a design file back in.

Every piece of text that came from a design is escaped for the format it goes into (Markdown, HTML, CSV), so a
hostile component name cannot inject markup, links, or spreadsheet formulas."""

from __future__ import annotations

import base64
import csv
import io
import json
import time
from html import escape as html_escape
from typing import Any

from pydantic import ValidationError

from app.schemas.models import AnalyzeRequest, ArchitectureResult, Requirements
from app.schemas.sharing import (
    DesignDocument,
    DocComponent,
    DocCost,
    DocCostLine,
    DocFinding,
    ImportResponse,
    KeyValue,
)
from app.services.ai_generator import _as_list, _clean
from app.services.diagram_svg import diagram_mermaid, diagram_svg
from app.services.pipeline import run_analysis
from app.services.sanitize import safe_text
from app.services.toolkit.adr import build_decisions
from app.services.toolkit.capacity import estimate_capacity
from app.services.toolkit.common import md
from app.services.toolkit.patterns import suggest_patterns
from app.services.toolkit.reliability import estimate_reliability

EXPORT_FORMAT = "sysdesign-ai"
EXPORT_VERSION = 1
MAX_IMPORT_BYTES = 2_000_000


# ---------- the document ----------


def _requirement_rows(reqs: Requirements) -> list[KeyValue]:
    rows = [
        ("Application type", reqs.application_type),
        ("Expected users", f"{reqs.expected_users:,.0f}" if reqs.expected_users else ""),
        ("Peak requests per second", f"{reqs.peak_requests_per_second:,.0f}" if reqs.peak_requests_per_second else ""),
        ("Availability target", reqs.availability_target),
        ("Monthly budget", f"${reqs.monthly_budget:,.0f}" if reqs.monthly_budget else ""),
        ("Cloud provider", reqs.cloud_provider),
        ("Region", reqs.region),
    ]
    rows += [("Note", n) for n in reqs.notes]
    return [KeyValue(label=k, value=safe_text(v, 300)) for k, v in rows if v]


def _settings(configuration: dict[str, Any]) -> str:
    return ", ".join(f"{safe_text(k, 60)} = {safe_text(json.dumps(v), 80)}" for k, v in list(configuration.items())[:8])


def build_document(request: AnalyzeRequest) -> DesignDocument:
    arch, reqs = request.architecture, request.requirements
    analysis = run_analysis(request)
    names = {c.id: c.name for c in arch.components}
    perf, cost = analysis.performance, analysis.cost

    findings = [
        DocFinding(severity=r.severity, issue=r.issue, recommendation=r.recommendation)
        for r in analysis.optimization.recommendations
    ]
    risks = [f"{f.issue}: {f.recommendation}" for f in findings if f.severity.lower() in ("high", "critical")]
    reliability = estimate_reliability(arch, reqs)
    capacity = estimate_capacity(arch, reqs)
    decisions = build_decisions(arch, reqs)
    patterns = suggest_patterns(arch, reqs)

    return DesignDocument(
        title=safe_text(arch.project_name, 200, "Architecture"),
        description=safe_text(arch.description, 2000),
        generated_on=time.strftime("%Y-%m-%d", time.gmtime()),
        requirements=_requirement_rows(reqs),
        assumptions=[safe_text(a, 500) for a in arch.assumptions],
        components=[
            DocComponent(
                name=safe_text(c.name, 200),
                type=safe_text(c.type, 100),
                provider=safe_text(c.provider, 50),
                settings=_settings(c.configuration),
            )
            for c in arch.components
        ],
        connections=[
            f"{names[c.source]} → {names[c.target]}" + (f" ({safe_text(c.label, 100)})" if c.label else "")
            for c in arch.connections
        ],
        mermaid=diagram_mermaid(arch),
        performance=[
            KeyValue(
                label="Peak traffic", value=f"{analysis.inputs.peak_requests_per_second:,.0f} requests per second"
            ),
            KeyValue(label="Web servers", value=str(analysis.inputs.number_of_servers)),
            KeyValue(label="Utilization", value=f"{perf.utilization_percentage:.1f}% ({perf.estimated_status})"),
            KeyValue(label="Bottleneck", value=safe_text(perf.bottleneck, 300)),
            KeyValue(label="Advice", value=safe_text(perf.recommendation, 500)),
        ],
        cost=DocCost(
            currency=cost.currency,
            lines=[
                DocCostLine(
                    name=safe_text(line.name, 200),
                    resource_type=safe_text(line.resource_type, 100),
                    quantity=line.quantity,
                    unit=safe_text(line.unit, 40),
                    unit_price=line.estimated_unit_monthly_price,
                    monthly_cost=line.monthly_cost,
                )
                for line in cost.breakdown
            ],
            total=cost.total_monthly_cost,
            budget=cost.monthly_budget or None,
            status=cost.budget_status,
            notice=safe_text(cost.notice, 500),
        ),
        recommendations=findings,
        risks=risks,
        capacity=capacity.headlines,
        reliability=reliability.verdicts,
        decisions=[f"{r.id}: {r.title}" for r in decisions.records],
        patterns=[
            f"{p.name} ({p.status}): {p.summary}" for p in patterns.patterns if p.status in ("recommended", "in place")
        ],
        notes=[
            "Costs, performance and the other figures are estimates from simple stated rules, not measurements or quotes.",
            *analysis.derived,
        ],
    )


# ---------- Markdown ----------


def _table(headers: list[str], rows: list[list[str]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    out += ["| " + " | ".join(md(c) for c in row) + " |" for row in rows]
    return out + [""]


def to_markdown(doc: DesignDocument) -> str:
    out = [f"# {md(doc.title)}", ""]
    if doc.description:
        out += [md(doc.description), ""]
    out += [f"*Generated {doc.generated_on} by SysDesign AI. All figures are estimates.*", ""]

    def section(title: str, items: list[str]) -> None:
        if items:
            out.extend([f"## {title}", "", *[f"- {md(i)}" for i in items], ""])

    if doc.requirements:
        out += ["## Requirements", ""] + _table(["Item", "Value"], [[r.label, r.value] for r in doc.requirements])
    section("Assumptions", doc.assumptions)
    out += ["## Diagram", "", "```mermaid", doc.mermaid.rstrip(), "```", ""]
    out += ["## Components", ""] + _table(
        ["Name", "Type", "Provider", "Settings"], [[c.name, c.type, c.provider, c.settings] for c in doc.components]
    )
    section("Connections", doc.connections)
    out += ["## Performance", ""] + _table(["Measure", "Estimate"], [[p.label, p.value] for p in doc.performance])
    out += ["## Cost", ""]
    out += _table(
        ["Item", "Type", "Quantity", "Unit price", "Monthly"],
        [
            [
                line.name,
                line.resource_type,
                f"{line.quantity:g} {line.unit}",
                f"${line.unit_price:,.2f}",
                f"${line.monthly_cost:,.2f}",
            ]
            for line in doc.cost.lines
        ],
    )
    budget = f" Budget ${doc.cost.budget:,.0f}: {doc.cost.status}." if doc.cost.budget else ""
    out += [f"**Total: ${doc.cost.total:,.2f} per month.**{md(budget)}", "", f"*{md(doc.cost.notice)}*", ""]
    if doc.recommendations:
        out += ["## Recommendations", ""] + _table(
            ["Severity", "Issue", "Recommendation"],
            [[r.severity, r.issue, r.recommendation] for r in doc.recommendations],
        )
    section("Risks", doc.risks)
    section("Capacity estimate", doc.capacity)
    section("Reliability", doc.reliability)
    section("Decisions", doc.decisions)
    section("Patterns", doc.patterns)
    section("Notes", doc.notes)
    return "\n".join(out).rstrip() + "\n"


# ---------- printable HTML (save as PDF from the browser's print dialog) ----------

_CSS = """
body{font:14px/1.5 "Segoe UI",Helvetica,Arial,sans-serif;color:#14233a;max-width:900px;margin:24px auto;padding:0 20px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:26px 0 8px;border-bottom:1px solid #d3dce7;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}th,td{border:1px solid #d3dce7;padding:5px 8px;text-align:left;vertical-align:top}
th{background:#f2f5f9}.muted{color:#55657d}.diagram{text-align:center;margin:12px 0}.diagram img{max-width:100%;height:auto}
.sev-high,.sev-critical{color:#b42318;font-weight:700}.sev-medium{color:#b45309;font-weight:700}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}table,.diagram{break-inside:avoid}}
"""


def _ul(items: list[str]) -> str:
    return "<ul>" + "".join(f"<li>{html_escape(i)}</li>" for i in items) + "</ul>" if items else ""


def _html_table(headers: list[str], rows: list[list[str]], classes: list[str] | None = None) -> str:
    head = "".join(f"<th>{html_escape(h)}</th>" for h in headers)
    body = ""
    for i, row in enumerate(rows):
        cls = f' class="{classes[i]}"' if classes else ""
        body += f"<tr{cls}>" + "".join(f"<td>{html_escape(c)}</td>" for c in row) + "</tr>"
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


def to_html(doc: DesignDocument, arch: ArchitectureResult) -> str:
    svg = base64.b64encode(diagram_svg(arch).encode("utf-8")).decode("ascii")
    parts = [
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width, initial-scale=1'>",
        f"<title>{html_escape(doc.title)}</title><style>{_CSS}</style></head><body>",
        f"<h1>{html_escape(doc.title)}</h1>",
        f"<p>{html_escape(doc.description)}</p>" if doc.description else "",
        f"<p class='muted'>Generated {html_escape(doc.generated_on)} by SysDesign AI. All figures are estimates. "
        "To save as PDF, use your browser's Print command and choose Save as PDF.</p>",
    ]
    if doc.requirements:
        parts += [
            "<h2>Requirements</h2>",
            _html_table(["Item", "Value"], [[r.label, r.value] for r in doc.requirements]),
        ]
    if doc.assumptions:
        parts += ["<h2>Assumptions</h2>", _ul(doc.assumptions)]
    parts += [
        "<h2>Diagram</h2>",
        f"<div class='diagram'><img alt='Architecture diagram of {html_escape(doc.title)}' src='data:image/svg+xml;base64,{svg}'></div>",
        "<h2>Components</h2>",
        _html_table(
            ["Name", "Type", "Provider", "Settings"], [[c.name, c.type, c.provider, c.settings] for c in doc.components]
        ),
        "<h2>Connections</h2>",
        _ul(doc.connections),
        "<h2>Performance</h2>",
        _html_table(["Measure", "Estimate"], [[p.label, p.value] for p in doc.performance]),
        "<h2>Cost</h2>",
        _html_table(
            ["Item", "Type", "Quantity", "Unit price", "Monthly"],
            [
                [
                    line.name,
                    line.resource_type,
                    f"{line.quantity:g} {line.unit}",
                    f"${line.unit_price:,.2f}",
                    f"${line.monthly_cost:,.2f}",
                ]
                for line in doc.cost.lines
            ],
        ),
        f"<p><strong>Total: ${doc.cost.total:,.2f} per month.</strong>"
        + (f" Budget ${doc.cost.budget:,.0f}: {html_escape(doc.cost.status)}." if doc.cost.budget else "")
        + f"</p><p class='muted'>{html_escape(doc.cost.notice)}</p>",
    ]
    if doc.recommendations:
        parts += [
            "<h2>Recommendations</h2>",
            _html_table(
                ["Severity", "Issue", "Recommendation"],
                [[r.severity, r.issue, r.recommendation] for r in doc.recommendations],
                [f"sev-{r.severity.lower()}" for r in doc.recommendations],
            ),
        ]
    for title, items in (
        ("Risks", doc.risks),
        ("Capacity estimate", doc.capacity),
        ("Reliability", doc.reliability),
        ("Decisions", doc.decisions),
        ("Patterns", doc.patterns),
        ("Notes", doc.notes),
    ):
        if items:
            parts += [f"<h2>{title}</h2>", _ul(items)]
    parts.append("</body></html>")
    return "".join(parts)


# ---------- cost CSV ----------


def _csv_cell(value: Any) -> Any:
    """Text that a spreadsheet could read as a formula is prefixed with an apostrophe (CSV injection)."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


def cost_csv(request: AnalyzeRequest) -> str:
    cost = run_analysis(request).cost
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerow(
        [
            "Item",
            "Type",
            "Quantity",
            "Unit",
            "Unit price per month",
            "Price source",
            "Discount percent",
            "Monthly cost",
            "Share of total percent",
        ]
    )
    for line in cost.breakdown:
        writer.writerow(
            [
                _csv_cell(v)
                for v in (
                    safe_text(line.name, 200),
                    safe_text(line.resource_type, 100),
                    line.quantity,
                    safe_text(line.unit, 40),
                    line.estimated_unit_monthly_price,
                    safe_text(line.price_source, 100),
                    line.discount_percent,
                    line.monthly_cost,
                    line.share_of_total_percentage,
                )
            ]
        )
    writer.writerow(["Total", "", "", "", "", "", "", cost.total_monthly_cost, 100 if cost.breakdown else 0])
    return buffer.getvalue()


# ---------- design files ----------


def export_file(architecture: ArchitectureResult, requirements: Requirements | None) -> dict[str, Any]:
    """The JSON a design is downloaded as."""
    return {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "architecture": json.loads(architecture.model_dump_json()),
        "requirements": json.loads(requirements.model_dump_json()) if requirements else None,
    }


def import_file(data: dict[str, Any]) -> ImportResponse:
    """A design from a file's contents. Accepts an export file or a bare architecture. The design goes through the
    same cleaning as an AI answer (control characters removed, bad links dropped) and then full validation."""
    if len(json.dumps(data)) > MAX_IMPORT_BYTES:
        raise ValueError("That file is too large to be a design.")
    wrapped = isinstance(data.get("architecture"), dict)
    raw = data["architecture"] if wrapped else data
    if wrapped and data.get("format") not in (None, EXPORT_FORMAT):
        raise ValueError("That file is not a SysDesign AI export.")
    if not isinstance(raw.get("components"), list):
        raise ValueError("That file does not look like a design: it has no list of components.")

    notes: list[str] = []
    try:
        cleaned = _clean(raw)
    except ValueError as exc:
        raise ValueError(f"That file does not hold a usable design: {exc}") from exc
    dropped_components = len(raw["components"]) - len(cleaned["components"])
    if dropped_components:
        notes.append(f"{dropped_components} component(s) were dropped (duplicate or unreadable).")
    dropped_links = len(_as_list(raw.get("connections"))) - len(cleaned["connections"])
    if dropped_links:
        notes.append(f"{dropped_links} connection(s) were dropped (unknown component or duplicate).")
    try:
        architecture = ArchitectureResult(**cleaned)
    except ValidationError as exc:
        raise ValueError(f"That design is not valid: {exc.errors()[0]['msg']}") from exc

    requirements = None
    if wrapped and isinstance(data.get("requirements"), dict):
        try:
            requirements = Requirements(**data["requirements"])
        except ValidationError:
            notes.append("The requirements in the file were not valid and were left out.")
    return ImportResponse(architecture=architecture, requirements=requirements, notes=notes)
