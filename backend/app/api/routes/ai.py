"""AI assistant routes: refine the design from a sentence, review it, regenerate while keeping edits, read a
document, and see usage and feedback. All of them need a login and share the per-user AI rate limit."""

from fastapi import APIRouter, Depends, HTTPException, Response

from app.api.routes.design import ai_error, ai_rate_limit
from app.schemas.ai import (
    DocumentRequest,
    DocumentResponse,
    FeedbackIn,
    HistoryResponse,
    RefineRequest,
    RefineResponse,
    RegenerateRequest,
    ReviewRequest,
    ReviewResponse,
    UsageResponse,
)
from app.schemas.models import ArchitectureResult
from app.security import get_current_user
from app.services import ai_assist, ai_usage
from app.services.ai_core import AIConfigError, AIGenerationError
from app.services.ai_generator import generate_architecture_ex

router = APIRouter(prefix="/api", tags=["ai"])


@router.post("/refine", response_model=RefineResponse, dependencies=[Depends(ai_rate_limit)])
def refine(request: RefineRequest, user: dict = Depends(get_current_user)):
    """A change to the design, from a sentence, as a patch plus a plain-language diff to accept or reject."""
    try:
        return ai_assist.refine(request.architecture, request.requirements, request.instruction, user_id=user["id"])
    except (AIConfigError, AIGenerationError, ValueError) as exc:
        raise ai_error(exc) from exc


@router.post("/regenerate", response_model=ArchitectureResult, dependencies=[Depends(ai_rate_limit)])
def regenerate(request: RegenerateRequest, response: Response, user: dict = Depends(get_current_user)):
    """Generate again from the prompt, with the current design as context so the user's edits are kept."""
    try:
        architecture, cached = generate_architecture_ex(
            request.prompt, user_id=user["id"], existing=request.architecture
        )
    except (AIConfigError, AIGenerationError, ValueError) as exc:
        raise ai_error(exc) from exc
    if cached:
        response.headers["X-AI-Cached"] = "1"
    return architecture


@router.post("/review", response_model=ReviewResponse, dependencies=[Depends(ai_rate_limit)])
def review(request: ReviewRequest, user: dict = Depends(get_current_user)):
    """A critique of the design, in the same shape as the rule-based recommendations, labelled by source."""
    try:
        return ai_assist.review(request.architecture, request.requirements, user_id=user["id"])
    except (AIConfigError, AIGenerationError, ValueError) as exc:
        raise ai_error(exc) from exc


@router.post("/import-document", response_model=DocumentResponse, dependencies=[Depends(ai_rate_limit)])
def import_document(request: DocumentRequest, user: dict = Depends(get_current_user)):
    """Requirements text from a text file, a PDF, or a picture of a diagram."""
    try:
        return ai_assist.read_document(request, user_id=user["id"])
    except (AIConfigError, AIGenerationError, ValueError) as exc:
        raise ai_error(exc) from exc


@router.get("/ai/usage", response_model=UsageResponse)
def usage(user: dict = Depends(get_current_user)):
    """This month's AI requests and tokens against the allowance, and the models in use."""
    return ai_usage.usage_summary(user["id"])


@router.get("/ai/history", response_model=HistoryResponse)
def history(user: dict = Depends(get_current_user)):
    """The user's recent prompts, newest first, with any rating."""
    return ai_usage.history(user["id"])


@router.post("/ai/feedback", status_code=204)
def feedback(body: FeedbackIn, user: dict = Depends(get_current_user)):
    """Thumbs up or down (and a short comment) on the design a prompt produced."""
    if not body.prompt.strip():
        raise HTTPException(422, "The prompt is empty")
    ai_usage.rate_generation(user["id"], body.prompt.strip(), body.project_name, body.rating, body.comment.strip())
    return Response(status_code=204)
