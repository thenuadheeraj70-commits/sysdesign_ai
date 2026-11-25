"""Request and response models for the planning tools: compare variants, presets, what-if, growth, budget advisor."""

from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.models import ArchitecturePatch, ArchitectureResult, Requirements

MAX_COMPARED = 6


class Settings(BaseModel):
    """What every planning tool needs besides the architecture: the same inputs the Analysis panel uses."""

    requirements: Requirements = Field(default_factory=Requirements)
    capacity_per_server: float | None = Field(default=None, gt=0, le=1e9)
    average_latency: float | None = Field(default=None, ge=0, le=1e7)
    # Share of the peak traffic the design serves. Compare and presets use each variant's own share instead.
    traffic_scale: float = Field(default=1.0, gt=0, le=1000)


# ---------- compare ----------


class VariantIn(BaseModel):
    id: str = Field(..., min_length=1, max_length=40)
    name: str = Field(..., min_length=1, max_length=60)
    architecture: ArchitectureResult
    traffic_scale: float = Field(default=1.0, gt=0, le=1000)


class CompareRequest(Settings):
    variants: list[VariantIn] = Field(..., min_length=1, max_length=MAX_COMPARED)


class IssueCounts(BaseModel):
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0


class VariantMetrics(BaseModel):
    id: str
    name: str
    error: str | None = None  # set when this variant could not be analyzed; the numbers below are then zero
    component_count: int = 0
    number_of_servers: int = 0
    requests_per_second: float = 0.0
    utilization_percentage: float = 0.0
    status: str = ""
    bottleneck: str = ""
    monthly_cost: float = 0.0
    budget_status: str = ""
    discount_savings: float = 0.0
    issues: IssueCounts = Field(default_factory=IssueCounts)
    single_points_of_failure: int = 0
    resilience_score: int = 0  # 0 to 100, higher is more resilient
    cost_rank: int = 0  # 1 = cheapest
    resilience_rank: int = 0  # 1 = most resilient


class CompareResponse(BaseModel):
    variants: list[VariantMetrics]
    recommended_id: str | None = None
    recommendation: str = ""
    notes: list[str] = Field(default_factory=list)


# ---------- presets ----------

PresetKind = Literal["cheap", "balanced", "highly_available", "dev", "staging", "production"]


class PresetRequest(Settings):
    architecture: ArchitectureResult
    kind: PresetKind


class PresetResponse(BaseModel):
    kind: PresetKind
    name: str
    description: str
    architecture: ArchitectureResult
    traffic_scale: float  # dev and staging variants serve only a fraction of the production traffic
    changes: list[str]  # what was changed, in plain words


# ---------- what-if ----------


class WhatIfRequest(Settings):
    architecture: ArchitectureResult
    rps_values: list[float] | None = Field(default=None, max_length=60)  # default: a spread around the peak


class WhatIfPoint(BaseModel):
    requests_per_second: float
    users_equivalent: float  # roughly how many users that traffic corresponds to
    utilization_percentage: float
    status: str
    bottleneck: str
    servers_needed: int  # to stay at or under the target utilization
    monthly_cost_if_scaled: float  # today's cost plus the extra web servers that would be needed


class WhatIfResponse(BaseModel):
    base_requests_per_second: float
    number_of_servers: int
    capacity_per_server: float
    capacity_requests_per_second: float  # where utilization reaches 100%
    comfortable_requests_per_second: float  # where it passes the "high" threshold
    target_utilization: float
    low_utilization_below: float  # status thresholds, so a chart can draw them
    high_utilization_above: float
    base_monthly_cost: float
    server_monthly_price: float
    points: list[WhatIfPoint]
    notes: list[str] = Field(default_factory=list)


# ---------- growth ----------


class GrowthRequest(Settings):
    architecture: ArchitectureResult
    monthly_growth_percent: float = Field(default=10.0, ge=0, le=100)
    months: int = Field(default=12, ge=1, le=36)


class GrowthTier(BaseModel):
    kind: str  # web, database, cache
    name: str
    instances: int
    capacity_per_instance: float
    assumption: str
    first_scale_month: int | None = None  # first month it passes the high-utilization threshold; None = never


class GrowthTierMonth(BaseModel):
    utilization_percentage: float
    instances_needed: int  # to stay at or under the target utilization


class GrowthMonth(BaseModel):
    month: int
    requests_per_second: float
    tiers: dict[str, GrowthTierMonth]
    monthly_cost_if_scaled: float


class GrowthResponse(BaseModel):
    months: list[GrowthMonth]
    tiers: list[GrowthTier]
    base_monthly_cost: float
    total_cost_if_scaled: float
    total_cost_unchanged: float
    target_utilization: float
    high_utilization_above: float
    assumptions: list[str]


# ---------- budget advisor ----------


class AdvisorRequest(Settings):
    architecture: ArchitectureResult
    budget: float = Field(..., ge=0, le=1e12)


class AdvisorStep(BaseModel):
    label: str
    saving: float
    total_after: float
    utilization_after: float
    risk: Literal["low", "medium", "high"]
    risk_note: str
    patch: ArchitecturePatch  # this step alone
    cumulative_patch: ArchitecturePatch  # this step and every step before it: apply this to go up to here


class AdvisorResponse(BaseModel):
    current_total: float
    budget: float
    over_by: float
    reachable: bool
    final_total: float
    steps: list[AdvisorStep]
    notes: list[str] = Field(default_factory=list)
