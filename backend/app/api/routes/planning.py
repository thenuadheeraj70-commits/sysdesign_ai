"""Planning tools: compare variants, presets, traffic what-if, growth projection and the budget advisor.

These only read the request and calculate; they never call the AI, so they need no login and cost nothing to run.
"""

from fastapi import APIRouter, HTTPException

from app.schemas.scenarios import (
    AdvisorRequest,
    AdvisorResponse,
    CompareRequest,
    CompareResponse,
    GrowthRequest,
    GrowthResponse,
    PresetRequest,
    PresetResponse,
    WhatIfRequest,
    WhatIfResponse,
)
from app.services import scenarios

router = APIRouter(prefix="/api", tags=["planning"])


@router.post("/compare", response_model=CompareResponse)
def compare(request: CompareRequest):
    """Side-by-side cost, utilization, issues and resilience for several designs, ranked."""
    try:
        return scenarios.compare_variants(request)
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/presets", response_model=PresetResponse)
def preset(request: PresetRequest):
    """The design rebuilt as a Cheap, Balanced, Highly available, dev, staging or production variant."""
    try:
        return scenarios.build_preset(request)
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/what-if", response_model=WhatIfResponse)
def what_if(request: WhatIfRequest):
    """Utilization, servers needed and cost across a range of traffic levels."""
    try:
        return scenarios.what_if(request)
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/growth", response_model=GrowthResponse)
def growth(request: GrowthRequest):
    """Month-by-month traffic growth, and when each tier needs to scale."""
    try:
        return scenarios.grow(request)
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/budget-advisor", response_model=AdvisorResponse)
def budget_advisor(request: AdvisorRequest):
    """The cheapest changes that bring the design under a budget, safest first."""
    try:
        return scenarios.advise_budget(request)
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc
