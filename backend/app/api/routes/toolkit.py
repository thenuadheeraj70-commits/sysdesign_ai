"""Design toolkit: capacity estimates, API and data-model design, sequence diagrams, decision records, patterns,
reliability, multi-region planning and explanations.

Everything here is rule-based calculation on the request; nothing calls the AI, so no login is needed.
"""

from fastapi import APIRouter, HTTPException

from app.schemas.toolkit import (
    ApiDesignResponse,
    CapacityResponse,
    DataModelResponse,
    DecisionsResponse,
    ExplainRequest,
    ExplainResponse,
    GlossaryResponse,
    GlossaryTerm,
    MultiRegionRequest,
    MultiRegionResponse,
    PatternsResponse,
    ReliabilityResponse,
    SequenceResponse,
    ToolkitRequest,
)
from app.services.toolkit import (
    adr,
    api_design,
    capacity,
    data_model,
    explain,
    glossary,
    patterns,
    regions,
    reliability,
    sequences,
)

router = APIRouter(prefix="/api", tags=["toolkit"])

_CALC_ERRORS = (ValueError, OverflowError, ZeroDivisionError)


@router.post("/capacity", response_model=CapacityResponse)
def capacity_estimate(request: ToolkitRequest):
    """Traffic, bandwidth, storage, cache, database and server estimates, each with its formula."""
    try:
        return capacity.estimate_capacity(request.architecture, request.requirements)
    except _CALC_ERRORS as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/api-design", response_model=ApiDesignResponse)
def api_design_route(request: ToolkitRequest):
    """REST endpoints grouped by service, with an OpenAPI skeleton."""
    return api_design.design_api(request.architecture, request.requirements)


@router.post("/data-model", response_model=DataModelResponse)
def data_model_route(request: ToolkitRequest):
    """Entities, relations, a Mermaid ER diagram and SQL for the design's database."""
    return data_model.design_data_model(request.architecture, request.requirements)


@router.post("/sequences", response_model=SequenceResponse)
def sequences_route(request: ToolkitRequest):
    """Request flows (read, sign-in, write, upload, search) through the components."""
    return sequences.design_sequences(request.architecture, request.requirements)


@router.post("/decisions", response_model=DecisionsResponse)
def decisions(request: ToolkitRequest):
    """Architecture decision records for the main choices in the design."""
    return adr.build_decisions(request.architecture, request.requirements)


@router.post("/patterns", response_model=PatternsResponse)
def pattern_suggestions(request: ToolkitRequest):
    """Design patterns that fit, are already in place, or are not needed."""
    return patterns.suggest_patterns(request.architecture, request.requirements)


@router.post("/reliability", response_model=ReliabilityResponse)
def reliability_estimate(request: ToolkitRequest):
    """Estimated availability, recovery time and data-loss window against the targets."""
    try:
        return reliability.estimate_reliability(request.architecture, request.requirements)
    except _CALC_ERRORS as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/multi-region", response_model=MultiRegionResponse)
def multi_region(request: MultiRegionRequest):
    """Latency, replication and failover for running in several regions, and a multi-region variant."""
    try:
        return regions.plan_multi_region(request)
    except _CALC_ERRORS as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/explain", response_model=ExplainResponse)
def explain_component(request: ExplainRequest):
    """What a component is, what it does in this design, its alternatives and common mistakes."""
    try:
        return explain.explain_component(request.architecture, request.requirements, request.component_id)
    except KeyError as exc:
        raise HTTPException(404, f"No component with id '{request.component_id}' in this design") from exc


@router.get("/glossary", response_model=GlossaryResponse)
def glossary_terms():
    """Definitions of the terms used across the tools."""
    return GlossaryResponse(terms=[GlossaryTerm(term=t, definition=d) for t, d in sorted(glossary.GLOSSARY.items())])
