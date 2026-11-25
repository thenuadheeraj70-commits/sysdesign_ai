"""Extract structured requirements (users, traffic, budget, ...) from the user's prompt."""

from pathlib import Path

from pydantic import ValidationError

from app import config
from app.schemas.models import Requirements
from app.services.ai_core import call_model, keep
from app.services.ai_generator import (
    MAX_REQUIREMENT_LENGTH,
    AIGenerationError,
    _extract_json,
    _get_client,
    wrap_requirement,
)
from app.services.demo import demo_requirements
from app.services.sanitize import safe_text

_PROMPT = (Path(__file__).resolve().parent.parent / "prompts" / "requirements_prompt.txt").read_text(encoding="utf-8")


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 and n < 1e12 else None


def extract_requirements(text: str, client=None, user_id: int | None = None) -> Requirements:
    text = (text or "").strip()
    if not text:
        raise ValueError("Requirement must not be empty")
    if len(text) > MAX_REQUIREMENT_LENGTH:
        raise ValueError(f"Requirement must be at most {MAX_REQUIREMENT_LENGTH} characters")
    if config.DEMO_MODE:
        return demo_requirements()
    client = client or _get_client()
    try:
        reply = call_model(
            client,
            "extraction",
            _PROMPT,
            [{"role": "user", "content": wrap_requirement(text)}],
            800,
            user_id=user_id,
        )
        data = _extract_json(reply.text)
    except ValueError as exc:
        raise AIGenerationError(f"AI returned invalid requirements: {exc}") from exc

    notes = data.get("notes")
    notes = (
        [safe_text(n, 300) for n in notes if isinstance(n, str) and safe_text(n, 300)][:20]
        if isinstance(notes, list)
        else []
    )

    def str_(value) -> str:
        return safe_text(value, 500)

    try:
        result = Requirements(
            application_type=str_(data.get("application_type"))[:200],
            expected_users=_number(data.get("expected_users")),
            peak_requests_per_second=_number(data.get("peak_requests_per_second")),
            availability_target=str_(data.get("availability_target"))[:100],
            monthly_budget=_number(data.get("monthly_budget")),
            cloud_provider=str_(data.get("cloud_provider")).lower()[:50],
            notes=notes,
        )
        keep(reply)
        return result
    except ValidationError as exc:
        raise AIGenerationError(f"AI returned invalid requirements: {exc}") from exc
