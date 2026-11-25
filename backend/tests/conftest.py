import os
import tempfile

# Must be set before the app is imported: tests use a throw-away database.
os.environ["DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["SECRET_KEY"] = "test-secret"
os.environ["AUTH_RATE_LIMIT_PER_MINUTE"] = "0"  # many tests register accounts; the limit has its own test

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _fresh_ai_state(monkeypatch):
    """Every test starts with an empty AI cache, a closed circuit breaker and no waiting between retries."""
    from app.services import ai_core

    # backend/.env may hold a real key: tests must never reach a real AI service or depend on its settings.
    for name in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "AI_PROVIDER", "AI_FALLBACK_MODEL", "AI_MONTHLY_TOKEN_QUOTA"):
        monkeypatch.delenv(name, raising=False)
    for task in (*ai_core.TASKS, ""):
        monkeypatch.delenv(f"AI_MODEL_{task.upper()}" if task else "AI_MODEL", raising=False)
    ai_core.clear_cache()
    ai_core.breaker.reset()
    monkeypatch.setattr(ai_core, "BASE_DELAY", 0.0)
    yield
    ai_core.clear_cache()
    ai_core.breaker.reset()
