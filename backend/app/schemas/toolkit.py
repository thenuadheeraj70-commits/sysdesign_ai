"""Request and response models for the system design toolkit."""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.models import ArchitecturePatch, ArchitectureResult, Requirements


class ToolkitRequest(BaseModel):
    """Every toolkit tool reads the design and the requirements."""

    architecture: ArchitectureResult
    requirements: Requirements = Field(default_factory=Requirements)


# ---------- capacity ----------


class CapacityInputOut(BaseModel):
    """One assumption, with where its value came from, so the screen can show it as an editable box."""

    key: str
    label: str
    value: float
    unit: str
    source: Literal["yours", "requirements", "default"]
    hint: str
    minimum: float
    maximum: float


class CapacityLine(BaseModel):
    section: str
    label: str
    value: float
    unit: str
    formula: str  # the calculation with the numbers filled in
    note: str = ""


class CapacityResponse(BaseModel):
    inputs: list[CapacityInputOut]
    lines: list[CapacityLine]
    headlines: list[str]
    comparison: list[str]  # how today's design compares with what the estimate says is needed
    notes: list[str]


# ---------- API design ----------


class ApiEndpoint(BaseModel):
    method: str
    path: str
    summary: str
    auth: Literal["public", "user", "admin", "service"]
    service: str  # the component expected to serve it ("" if none)
    idempotent: bool = False
    paginated: bool = False
    note: str = ""


class ApiGroup(BaseModel):
    name: str
    description: str
    endpoints: list[ApiEndpoint]


class ApiDesignResponse(BaseModel):
    domain: str
    base_path: str
    conventions: list[str]
    groups: list[ApiGroup]
    openapi: dict[str, Any]
    notes: list[str]


# ---------- data model ----------


class EntityField(BaseModel):
    name: str
    type: str  # generic type: uuid, text, int, decimal, bool, timestamp, json
    key: Literal["", "pk", "fk", "unique"] = ""
    nullable: bool = False
    references: str = ""  # for a foreign key: the entity it points to
    note: str = ""


class Entity(BaseModel):
    name: str
    description: str
    store: str  # relational, cache, object storage, search index
    fields: list[EntityField]
    indexes: list[str] = Field(default_factory=list)
    note: str = ""


class Relation(BaseModel):
    source: str
    target: str
    kind: Literal["one-to-many", "many-to-many", "one-to-one"]
    via: str


class DataModelResponse(BaseModel):
    domain: str
    dialect: str  # postgres, mysql, or none
    entities: list[Entity]
    relations: list[Relation]
    mermaid: str  # ER diagram text
    sql: str  # CREATE TABLE statements for the relational entities ("" if there is no relational database)
    notes: list[str]


# ---------- sequence diagrams ----------


class SequenceParticipant(BaseModel):
    id: str
    name: str
    kind: str  # client, cdn, entry, api, auth, cache, database, queue, worker, storage, search


class SequenceStep(BaseModel):
    kind: Literal["call", "return", "async", "note", "alt", "else", "end"]
    source: str = ""
    target: str = ""
    label: str = ""


class SequenceFlow(BaseModel):
    id: str
    title: str
    description: str
    available: bool
    reason: str = ""  # why it is not available
    participants: list[SequenceParticipant] = Field(default_factory=list)
    steps: list[SequenceStep] = Field(default_factory=list)
    mermaid: str = ""


class SequenceResponse(BaseModel):
    domain: str
    flows: list[SequenceFlow]


# ---------- decision records ----------


class Alternative(BaseModel):
    name: str
    pros: list[str]
    cons: list[str]


class DecisionRecord(BaseModel):
    id: str  # ADR-001
    title: str
    status: Literal["Proposed", "Accepted"] = "Proposed"
    context: str
    decision: str
    alternatives: list[Alternative]
    consequences: list[str]
    components: list[str]  # ids of the components this is about


class DecisionsResponse(BaseModel):
    records: list[DecisionRecord]
    markdown: str


# ---------- patterns ----------


class PatternSuggestion(BaseModel):
    id: str
    name: str
    status: Literal["recommended", "consider", "in place", "not needed"]
    summary: str  # one sentence
    why: str  # the evidence in this design
    when_to_use: str
    when_not_to: str
    trade_offs: str
    how: str  # what it would look like here
    fix: ArchitecturePatch | None = None


class PatternsResponse(BaseModel):
    patterns: list[PatternSuggestion]


# ---------- reliability ----------


class ReliabilityComponent(BaseModel):
    id: str
    name: str
    availability_percent: float
    why: str
    on_critical_path: bool


class ReliabilityAdvice(BaseModel):
    title: str
    detail: str
    fix: ArchitecturePatch | None = None


class ReliabilityResponse(BaseModel):
    estimated_availability_percent: float
    downtime_minutes_per_year: float
    downtime_minutes_per_month: float
    target_availability_percent: float | None
    availability_gap_percent: float | None  # estimate minus target; negative means short of the target
    estimated_rto_minutes: float
    estimated_rpo_minutes: float
    rto_reason: str
    rpo_reason: str
    components: list[ReliabilityComponent]
    verdicts: list[str]  # plain statements about each target
    advice: list[ReliabilityAdvice]
    assumptions: list[str]


# ---------- multi-region ----------


class RegionInfo(BaseModel):
    code: str
    name: str


class MultiRegionRequest(ToolkitRequest):
    primary_region: str = Field(default="us-east-1", max_length=30)
    secondary_regions: list[str] = Field(default_factory=list, max_length=4)
    mode: Literal["active-passive", "active-active"] = "active-passive"
    user_regions: list["UserRegionShare"] = Field(default_factory=list, max_length=12)


class UserRegionShare(BaseModel):
    region: str = Field(..., max_length=30)  # where users are, expressed as the nearest cloud region
    percent: float = Field(..., ge=0, le=100)


class LatencyRow(BaseModel):
    user_region: str
    percent: float
    nearest_region: str
    primary_latency_ms: float
    best_latency_ms: float


class ReplicationLink(BaseModel):
    what: str
    source_region: str
    target_region: str
    mode: str
    lag_seconds: float
    note: str


class MultiRegionResponse(BaseModel):
    regions: list[RegionInfo]
    latency_matrix: dict[str, dict[str, float]]
    latency_rows: list[LatencyRow]
    average_latency_before_ms: float | None
    average_latency_after_ms: float | None
    links: list[ReplicationLink]
    failover: list[str]
    changes: list[str]
    architecture: ArchitectureResult | None  # a ready-made multi-region variant
    notes: list[str]


MultiRegionRequest.model_rebuild()


# ---------- explain and glossary ----------


class ExplainRequest(ToolkitRequest):
    component_id: str = Field(..., min_length=1, max_length=100)


class ExplainAlternative(BaseModel):
    name: str
    choose_when: str


class ExplainResponse(BaseModel):
    component_id: str
    name: str
    kind: str
    what_it_is: str
    role_here: str
    receives_from: list[str]
    sends_to: list[str]
    alternatives: list[ExplainAlternative]
    pitfalls: list[str]
    terms: list[str]  # glossary terms used, so the screen can show their definitions


class GlossaryTerm(BaseModel):
    term: str
    definition: str


class GlossaryResponse(BaseModel):
    terms: list[GlossaryTerm]
