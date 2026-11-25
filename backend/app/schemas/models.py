from typing import Any

from pydantic import BaseModel, Field, model_validator


class RootResponse(BaseModel):
    name: str
    version: str
    message: str


class HealthResponse(BaseModel):
    status: str


class ArchitectureRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)


class ArchitectureComponent(BaseModel):
    id: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=1, max_length=200)
    type: str = Field(..., min_length=1, max_length=100)
    provider: str = Field(..., min_length=1, max_length=50)
    configuration: dict[str, Any] = Field(default_factory=dict)


class ArchitectureConnection(BaseModel):
    source: str = Field(..., min_length=1)
    target: str = Field(..., min_length=1)
    label: str = Field(default="", max_length=300)


class ArchitectureResult(BaseModel):
    project_name: str = Field(..., min_length=1)
    description: str = ""
    components: list[ArchitectureComponent] = Field(default_factory=list, max_length=100)
    connections: list[ArchitectureConnection] = Field(default_factory=list, max_length=300)
    assumptions: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def check_architecture(self):
        ids = [c.id for c in self.components]
        if len(ids) != len(set(ids)):
            raise ValueError("Component ids must be unique")
        known = set(ids)
        for conn in self.connections:
            if conn.source not in known or conn.target not in known:
                raise ValueError("Every connection must reference an existing component")
        return self


class SimulationRequest(BaseModel):
    incoming_requests_per_second: float = Field(..., ge=0, le=1e12)
    number_of_servers: int = Field(..., ge=1, le=1_000_000)
    capacity_per_server: float = Field(..., gt=0, le=1e9)
    average_latency: float = Field(..., ge=0, le=1e7)


class SimulationResponse(BaseModel):
    total_capacity: float
    utilization_percentage: float
    estimated_status: str
    bottleneck: str
    recommendation: str
    explanation: list[str]
    disclaimer: str


class CostComponent(BaseModel):
    id: str
    name: str = ""
    resource_type: str
    quantity: float = Field(..., ge=0, le=1e9)
    estimated_unit_monthly_price: float | None = Field(default=None, ge=0, le=1e9)


class CostRequest(BaseModel):
    monthly_budget: float = Field(..., ge=0, le=1e12)
    components: list[CostComponent] = Field(default_factory=list, max_length=50)


class CostLineItem(BaseModel):
    id: str
    name: str
    resource_type: str
    unit: str
    quantity: float
    estimated_unit_monthly_price: float
    price_source: str
    monthly_cost: float
    share_of_total_percentage: float
    discount_percent: float = 0.0  # reserved/savings-plan and spot discounts already applied to the price


class CostResponse(BaseModel):
    is_estimate: bool
    notice: str
    currency: str
    breakdown: list[CostLineItem]
    total_monthly_cost: float
    monthly_budget: float
    budget_difference: float
    budget_status: str
    explanation: list[str]
    discount_savings: float = 0.0  # how much cheaper this is than the list prices


class PerformanceContext(BaseModel):
    utilization_percentage: float | None = None


class CostContext(BaseModel):
    total_monthly_cost: float
    monthly_budget: float


class OptimizeRequest(BaseModel):
    architecture: ArchitectureResult
    performance: PerformanceContext | None = None
    cost: CostContext | None = None


class ComponentUpdate(BaseModel):
    """Configuration keys to merge into an existing component."""

    id: str = Field(..., min_length=1, max_length=100)
    configuration: dict[str, Any] = Field(default_factory=dict)


class ArchitecturePatch(BaseModel):
    """A concrete change to an architecture: what "Apply fix" does."""

    label: str = Field(..., max_length=300)
    add_components: list[ArchitectureComponent] = Field(default_factory=list, max_length=20)
    add_connections: list[ArchitectureConnection] = Field(default_factory=list, max_length=50)
    update_components: list[ComponentUpdate] = Field(default_factory=list, max_length=100)
    remove_components: list[str] = Field(default_factory=list, max_length=50)  # ids; their connections go too


class ApplyFixRequest(BaseModel):
    architecture: ArchitectureResult
    patch: ArchitecturePatch


class Recommendation(BaseModel):
    id: str
    severity: str
    confidence: str
    issue: str
    explanation: str
    recommendation: str
    affected_components: list[str] = Field(default_factory=list)
    fix: ArchitecturePatch | None = None


class OptimizationResult(BaseModel):
    summary: str
    recommendations: list[Recommendation]
    limitations: list[str]
    notice: str


class GeneratedFile(BaseModel):
    path: str
    content: str


class SkippedComponent(BaseModel):
    id: str
    name: str
    reason: str


class TerraformResult(BaseModel):
    files: list[GeneratedFile]
    generated_components: list[dict[str, Any]]
    warnings: list[str] = []
    skipped_components: list[SkippedComponent] = []
    notice: str


class KubernetesOutput(BaseModel):
    available: bool
    files: list[GeneratedFile]
    message: str
    warnings: list[str] = []
    skipped_components: list[SkippedComponent] = []
    notice: str = ""


class GenerateCodeResult(BaseModel):
    project_name: str
    terraform: TerraformResult
    kubernetes: KubernetesOutput
    notice: str


# ---------- Connected pipeline ----------


class TrafficProfile(BaseModel):
    """The shape of the traffic, beyond one peak number."""

    peak_to_average: float = Field(default=10.0, ge=1, le=100)  # busiest moment vs the daily average
    surge_multiplier: float = Field(default=1.0, ge=1, le=20)  # short surges on top of the peak (1 = none)
    read_ratio: float = Field(default=0.8, ge=0, le=1)  # share of requests that only read data
    cache_hit_ratio: float = Field(default=0.7, ge=0, le=1)  # share of reads a cache answers (if there is one)


class CostDiscounts(BaseModel):
    """Optional price reductions, as percentages of the list price."""

    commitment_percent: float = Field(default=0.0, ge=0, le=70)  # reserved instances / savings plans
    spot_share_percent: float = Field(default=0.0, ge=0, le=100)  # share of background workers run on spot
    spot_discount_percent: float = Field(default=70.0, ge=0, le=90)


class ReliabilityTargets(BaseModel):
    """What the system must achieve when things fail. Empty means "no target set"."""

    availability_percent: float | None = Field(default=None, gt=0, lt=100)  # for example 99.9
    rto_minutes: float | None = Field(default=None, ge=0, le=1e6)  # how long recovery may take
    rpo_minutes: float | None = Field(default=None, ge=0, le=1e6)  # how much recent data may be lost


class CapacityInputs(BaseModel):
    """Assumptions for the capacity estimate. Empty means "work it out or use the default"."""

    total_users: float | None = Field(default=None, ge=0, le=1e10)
    active_user_fraction: float | None = Field(default=None, ge=0, le=1)
    requests_per_user_per_day: float | None = Field(default=None, ge=0, le=1e6)
    peak_to_average: float | None = Field(default=None, ge=1, le=100)
    read_ratio: float | None = Field(default=None, ge=0, le=1)
    request_kb: float | None = Field(default=None, ge=0, le=1e6)
    response_kb: float | None = Field(default=None, ge=0, le=1e6)
    record_kb: float | None = Field(default=None, ge=0, le=1e6)
    retention_years: float | None = Field(default=None, ge=0, le=100)
    replication_factor: float | None = Field(default=None, ge=1, le=10)
    yearly_growth_percent: float | None = Field(default=None, ge=0, le=1000)
    cache_hit_ratio: float | None = Field(default=None, ge=0, le=1)
    hot_data_fraction: float | None = Field(default=None, ge=0, le=1)
    db_qps_per_shard: float | None = Field(default=None, gt=0, le=1e9)
    db_storage_gb_per_shard: float | None = Field(default=None, gt=0, le=1e9)
    server_qps: float | None = Field(default=None, gt=0, le=1e9)


class Requirements(BaseModel):
    """What the user's description implies. Every field is optional/estimated."""

    application_type: str = Field(default="", max_length=200)
    expected_users: float | None = Field(default=None, ge=0, le=1e10)
    peak_requests_per_second: float | None = Field(default=None, ge=0, le=1e12)
    availability_target: str = Field(default="", max_length=100)
    monthly_budget: float | None = Field(default=None, ge=0, le=1e12)
    cloud_provider: str = Field(default="", max_length=50)
    region: str = Field(default="", max_length=30)
    notes: list[str] = Field(default_factory=list, max_length=20)
    traffic_profile: TrafficProfile = Field(default_factory=TrafficProfile)
    discounts: CostDiscounts = Field(default_factory=CostDiscounts)
    reliability: ReliabilityTargets = Field(default_factory=ReliabilityTargets)
    capacity_inputs: CapacityInputs = Field(default_factory=CapacityInputs)


class RequirementsRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=5000)


class AnalyzeRequest(BaseModel):
    architecture: ArchitectureResult
    requirements: Requirements = Field(default_factory=Requirements)
    capacity_per_server: float | None = Field(default=None, gt=0, le=1e9)
    average_latency: float | None = Field(default=None, ge=0, le=1e7)
    traffic_scale: float = Field(default=1.0, gt=0, le=1000)  # multiplies the peak (used for dev/staging variants)


class PreviewFixRequest(AnalyzeRequest):
    patch: ArchitecturePatch


class AnalysisSnapshot(BaseModel):
    """The headline numbers of one analysis, used to compare before and after a fix."""

    component_count: int
    number_of_servers: int
    utilization_percentage: float
    total_monthly_cost: float
    budget_status: str
    issue_count: int


class FixPreview(BaseModel):
    before: AnalysisSnapshot
    after: AnalysisSnapshot


class CatalogResponse(BaseModel):
    types: list[str]
    providers: list[str]


class AnalysisInputs(BaseModel):
    peak_requests_per_second: float
    number_of_servers: int
    capacity_per_server: float
    average_latency: float
    monthly_budget: float | None = None
    # Peak x scale x surge: what the servers are sized against. None means the same as the peak.
    effective_requests_per_second: float | None = None


class AnalysisResponse(BaseModel):
    inputs: AnalysisInputs
    derived: list[str]  # every assumption the pipeline made on the user's behalf
    performance: SimulationResponse
    cost: CostResponse
    optimization: OptimizationResult
