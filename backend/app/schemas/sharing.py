"""Models for exporting, sharing and versioning designs."""

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.models import ArchitectureResult, Requirements


class ImportRequest(BaseModel):
    """A design file's contents: either an architecture, or an export wrapper that holds one."""

    data: dict[str, Any]


class ImportResponse(BaseModel):
    architecture: ArchitectureResult
    requirements: Requirements | None = None
    notes: list[str] = Field(default_factory=list)  # what was repaired or dropped


class KeyValue(BaseModel):
    label: str
    value: str


class DocComponent(BaseModel):
    name: str
    type: str
    provider: str
    settings: str


class DocCostLine(BaseModel):
    name: str
    resource_type: str
    quantity: float
    unit: str
    unit_price: float
    monthly_cost: float


class DocCost(BaseModel):
    currency: str
    lines: list[DocCostLine]
    total: float
    budget: float | None
    status: str
    notice: str


class DocFinding(BaseModel):
    severity: str
    issue: str
    recommendation: str


class DesignDocument(BaseModel):
    """Everything a reader needs about a design, as plain data: the shared page renders it, and the Markdown and
    printable exports are made from it."""

    title: str
    description: str
    generated_on: str
    requirements: list[KeyValue]
    assumptions: list[str]
    components: list[DocComponent]
    connections: list[str]
    mermaid: str
    performance: list[KeyValue]
    cost: DocCost
    recommendations: list[DocFinding]
    risks: list[str]
    capacity: list[str]
    reliability: list[str]
    decisions: list[str]
    patterns: list[str]
    notes: list[str]


class ShareStatus(BaseModel):
    shared: bool
    token: str | None = None
    path: str | None = None  # where the shared page lives, relative to the app


class SharedDesign(BaseModel):
    name: str
    updated_at: str
    document: DesignDocument
    architecture: ArchitectureResult


class VersionSummary(BaseModel):
    id: int
    label: str
    created_at: str
    component_count: int
    variant_count: int


class VersionList(BaseModel):
    items: list[VersionSummary]


class VersionDiff(BaseModel):
    version: VersionSummary
    added: list[str]
    removed: list[str]
    changed: list[str]
    renamed: str = ""  # "Old name -> New name" if the project was renamed since
    identical: bool
