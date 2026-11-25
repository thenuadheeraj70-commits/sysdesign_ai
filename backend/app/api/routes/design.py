import json
import queue
import threading

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse

from app.config import RATE_LIMIT_PER_MINUTE
from app.rate_limit import RateLimiter
from app.schemas.models import (
    AnalysisResponse,
    AnalyzeRequest,
    ApplyFixRequest,
    ArchitectureRequest,
    ArchitectureResult,
    CatalogResponse,
    CostRequest,
    CostResponse,
    FixPreview,
    OptimizationResult,
    OptimizeRequest,
    PreviewFixRequest,
    Requirements,
    RequirementsRequest,
    SimulationRequest,
    SimulationResponse,
)
from app.security import get_current_user
from app.services.ai_core import AIConfigError, AIGenerationError, AIQuotaError, AIUnavailableError
from app.services.ai_generator import generate_architecture_ex
from app.services.ai_usage import record_generation
from app.services.catalog import PROVIDERS, SUPPORTED_TYPES
from app.services.patch import apply_patch
from app.services.performance_analyzer import simulate_performance
from app.services.pipeline import build_cost_response, preview_fix, run_analysis
from app.services.recommendation_engine import analyze_architecture
from app.services.requirements_extractor import extract_requirements

router = APIRouter(prefix="/api")

_ai_limiter = RateLimiter(RATE_LIMIT_PER_MINUTE)


def ai_rate_limit(user: dict = Depends(get_current_user)):
    if not _ai_limiter.allow(str(user["id"])):
        raise HTTPException(429, "Too many requests. Please wait a minute and try again.")


def ai_error_parts(exc: Exception) -> tuple[int, str]:
    """The HTTP status and a message the user can act on, for an AI failure."""
    if isinstance(exc, ValueError):
        return 422, str(exc)
    if isinstance(exc, AIConfigError):
        return 500, str(exc)
    if isinstance(exc, AIQuotaError):
        return 429, str(exc)
    if isinstance(exc, AIUnavailableError):
        return 503, str(exc)
    return 502, str(exc)


def ai_error(exc: Exception) -> HTTPException:
    status, message = ai_error_parts(exc)
    return HTTPException(status, message)


@router.post("/architecture", response_model=ArchitectureResult, dependencies=[Depends(ai_rate_limit)])
def create_architecture(request: ArchitectureRequest, response: Response, user: dict = Depends(get_current_user)):
    try:
        architecture, cached = generate_architecture_ex(request.prompt, user_id=user["id"])
    except (ValueError, AIConfigError, AIGenerationError) as exc:
        raise ai_error(exc) from exc
    record_generation(user["id"], request.prompt.strip(), architecture.project_name)
    if cached:
        response.headers["X-AI-Cached"] = "1"
    return architecture


@router.post("/architecture/stream", dependencies=[Depends(ai_rate_limit)])
def stream_architecture(request: ArchitectureRequest, user: dict = Depends(get_current_user)):
    """The same as /architecture, but as lines of JSON: progress while the model writes, then the result."""
    events: queue.Queue = queue.Queue()

    def work() -> None:
        written = 0
        reported = 0

        def on_text(piece: str) -> None:
            nonlocal written, reported
            written += len(piece)
            if written - reported >= 200:
                reported = written
                events.put({"event": "progress", "characters": written})

        try:
            events.put({"event": "progress", "characters": 0})
            architecture, cached = generate_architecture_ex(request.prompt, user_id=user["id"], on_text=on_text)
            record_generation(user["id"], request.prompt.strip(), architecture.project_name)
            events.put({"event": "result", "cached": cached, "architecture": architecture.model_dump()})
        except (ValueError, AIConfigError, AIGenerationError) as exc:
            status, message = ai_error_parts(exc)
            events.put({"event": "error", "status": status, "message": message})
        except Exception:  # never leave the stream hanging
            events.put({"event": "error", "status": 500, "message": "Something went wrong while generating."})
        finally:
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def lines():
        while (item := events.get()) is not None:
            yield json.dumps(item) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@router.post("/simulate", response_model=SimulationResponse)
def simulate(request: SimulationRequest):
    try:
        return simulate_performance(**request.model_dump())
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/cost", response_model=CostResponse)
def cost(request: CostRequest):
    try:
        return build_cost_response(request.components, request.monthly_budget)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/requirements", response_model=Requirements, dependencies=[Depends(ai_rate_limit)])
def requirements(request: RequirementsRequest, user: dict = Depends(get_current_user)):
    try:
        return extract_requirements(request.prompt, user_id=user["id"])
    except (ValueError, AIConfigError, AIGenerationError) as exc:
        raise ai_error(exc) from exc


@router.post("/analyze", response_model=AnalysisResponse)
def analyze(request: AnalyzeRequest):
    """Architecture + requirements -> performance, cost and recommendations in one call."""
    try:
        return run_analysis(request)
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/catalog", response_model=CatalogResponse)
def catalog():
    """Component types and cloud providers the app understands (single source for the UI)."""
    return CatalogResponse(types=SUPPORTED_TYPES, providers=PROVIDERS)


@router.post("/preview-fix", response_model=FixPreview)
def preview_a_fix(request: PreviewFixRequest):
    """Headline numbers (cost, utilization, servers, issues) before and after a fix, without applying it."""
    try:
        return preview_fix(request)
    except (ValueError, OverflowError, ZeroDivisionError) as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/apply-fix", response_model=ArchitectureResult)
def apply_fix(request: ApplyFixRequest):
    """Apply a recommendation's fix to the architecture and return the updated architecture."""
    try:
        return apply_patch(request.architecture, request.patch)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/optimize", response_model=OptimizationResult)
def optimize(request: OptimizeRequest):
    try:
        return analyze_architecture(
            request.architecture,
            request.performance.utilization_percentage if request.performance else None,
            request.cost.total_monthly_cost if request.cost else None,
            request.cost.monthly_budget if request.cost else None,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
