"""What the AI has been used for: token usage per month, past prompts, and ratings of the results."""

from __future__ import annotations

import time

from app import config
from app.db import get_conn
from app.schemas.ai import HistoryItem, HistoryResponse, UsageByTask, UsageResponse
from app.services import ai_core

HISTORY_LIMIT = 30
KEEP_PER_USER = 200  # older prompts are dropped so the table cannot grow without bound


def usage_summary(user_id: int) -> UsageResponse:
    start = ai_core._month_start()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT task, COUNT(*) AS requests, COALESCE(SUM(cached), 0) AS cached, "
            "COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens "
            "FROM ai_usage WHERE user_id = ? AND created_at >= ? GROUP BY task ORDER BY task",
            (user_id, start),
        ).fetchall()
    by_task = [UsageByTask(**dict(r)) for r in rows]
    settings = ai_core.settings_summary()
    inp = sum(t.input_tokens for t in by_task)
    out = sum(t.output_tokens for t in by_task)
    return UsageResponse(
        month=time.strftime("%Y-%m", time.gmtime()),
        requests=sum(t.requests for t in by_task),
        cached_requests=sum(t.cached for t in by_task),
        input_tokens=inp,
        output_tokens=out,
        tokens_used=inp + out,
        quota=settings["monthly_token_quota"],
        by_task=by_task,
        provider=settings.get("provider", ""),
        models=settings["models"],
        fallback_model=settings["fallback_model"],
        demo_mode=config.DEMO_MODE,
    )


def record_generation(user_id: int, prompt: str, project_name: str = "") -> None:
    """Remember a prompt that produced a design, newest first in the history."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO ai_generations (user_id, prompt, project_name) VALUES (?, ?, ?)",
            (user_id, prompt[:5000], project_name[:200]),
        )
        conn.execute(
            "DELETE FROM ai_generations WHERE user_id = ? AND id NOT IN "
            "(SELECT id FROM ai_generations WHERE user_id = ? ORDER BY id DESC LIMIT ?)",
            (user_id, user_id, KEEP_PER_USER),
        )


def rate_generation(user_id: int, prompt: str, project_name: str, rating: int, comment: str) -> None:
    """Attach a thumbs up/down and a comment to the user's latest generation of this prompt."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id FROM ai_generations WHERE user_id = ? AND prompt = ? ORDER BY id DESC LIMIT 1",
            (user_id, prompt[:5000]),
        ).fetchone()
        if row:
            conn.execute("UPDATE ai_generations SET rating = ?, comment = ? WHERE id = ?", (rating, comment, row["id"]))
        else:
            conn.execute(
                "INSERT INTO ai_generations (user_id, prompt, project_name, rating, comment) VALUES (?, ?, ?, ?, ?)",
                (user_id, prompt[:5000], project_name[:200], rating, comment),
            )


def history(user_id: int) -> HistoryResponse:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, prompt, project_name, rating, comment, created_at FROM ai_generations "
            "WHERE user_id = ? ORDER BY id DESC LIMIT ?",
            (user_id, HISTORY_LIMIT),
        ).fetchall()
    return HistoryResponse(items=[HistoryItem(**dict(r)) for r in rows])
