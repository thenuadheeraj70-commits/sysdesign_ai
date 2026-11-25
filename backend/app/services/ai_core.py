"""Everything between the app and the AI APIs (Anthropic Claude and Google Gemini).

  * unified provider support: Google Gemini (via REST API) and Anthropic Claude,
  * one place that picks the model for each task (and an optional fallback model),
  * retries with backoff on rate-limit, overload and connection errors,
  * a circuit breaker so a struggling service is not hammered,
  * a short-lived response cache,
  * token usage per user, and a monthly quota,
  * optional streaming of the reply as it is written.

Callers pass a client (tests pass a fake) and get back a `ModelReply`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx
from anthropic import Anthropic, APIConnectionError, APIError, APIStatusError, RateLimitError
from dotenv import load_dotenv

from app.db import get_conn

load_dotenv()
_env_file = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
if os.path.exists(_env_file):
    load_dotenv(_env_file)

DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5"
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
DEFAULT_MODEL = DEFAULT_CLAUDE_MODEL
TASKS = ("generation", "extraction", "review", "refine", "document")

RETRIES = 4  # attempts per model on a retryable error (waits 1, 2, 4 seconds between them)
BASE_DELAY = float(os.getenv("AI_RETRY_BASE_DELAY", "1.0"))
BREAKER_THRESHOLD = 5  # failed calls in a row before the breaker opens
BREAKER_SECONDS = 60
CACHE_ENTRIES = 200


class AIConfigError(Exception):
    """The AI service is not configured (e.g. missing API key)."""


class AIGenerationError(Exception):
    """The AI could not produce a valid result."""


class AIQuotaError(AIGenerationError):
    """The user has used this month's AI allowance."""


class AIUnavailableError(AIGenerationError):
    """The AI service has been failing, so calls are paused for a moment."""


@dataclass
class ModelReply:
    text: str = ""
    tool_input: dict[str, Any] | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    model: str = ""
    cached: bool = False
    cache_key: str = ""  # set when the answer may be kept with keep() once the caller has checked it


# ---------- Provider & Settings ----------


def is_gemini_active() -> bool:
    provider = os.getenv("AI_PROVIDER", "").strip().lower()
    if provider == "gemini":
        return True
    if provider == "anthropic":
        return False
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    model = os.getenv("AI_MODEL", "").strip().lower()
    if model.startswith("gemini"):
        return True
    if gemini_key and not anthropic_key:
        return True
    return False


def default_model() -> str:
    return DEFAULT_GEMINI_MODEL if is_gemini_active() else DEFAULT_CLAUDE_MODEL


def model_for(task: str) -> str:
    """The model for a task: AI_MODEL_<TASK>, else AI_MODEL, else the default."""
    return os.getenv(f"AI_MODEL_{task.upper()}") or os.getenv("AI_MODEL") or default_model()


def fallback_model() -> str:
    return os.getenv("AI_FALLBACK_MODEL", "").strip()


def monthly_quota() -> int:
    """Tokens (input + output) a user may use per calendar month; 0 means unlimited."""
    try:
        return max(0, int(os.getenv("AI_MONTHLY_TOKEN_QUOTA", "500000")))
    except ValueError:
        return 500000


def cache_seconds() -> int:
    try:
        return max(0, int(os.getenv("AI_CACHE_SECONDS", "600")))
    except ValueError:
        return 600


def settings_summary() -> dict[str, Any]:
    return {
        "provider": "gemini" if is_gemini_active() else "anthropic",
        "models": {task: model_for(task) for task in TASKS},
        "fallback_model": fallback_model() or None,
        "monthly_token_quota": monthly_quota(),
        "cache_seconds": cache_seconds(),
    }


# ---------- Gemini Client Adapter ----------


def _stream_error(url: str, data: dict[str, Any]) -> httpx.HTTPStatusError:
    """An error Gemini reported inside a response stream, as the exception the retry logic understands."""
    error = data.get("error") or {}
    raw_code = error.get("code")
    code: int = raw_code if isinstance(raw_code, int) else 503
    message = str(error.get("message") or "Gemini reported an error")
    return httpx.HTTPStatusError(
        f"{code}: {message}", request=httpx.Request("POST", url), response=httpx.Response(code)
    )


class GeminiClient:
    """Client for Google Gemini REST API (v1beta)."""

    def __init__(self, api_key: str, base_url: str = "https://generativelanguage.googleapis.com/v1beta") -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    def _headers(self) -> dict[str, str]:
        # The key goes in a header, never in the URL: URLs end up in error messages and logs.
        return {"x-goog-api-key": self.api_key}

    def generate(
        self,
        model: str,
        system: str,
        messages: list[Any],
        max_tokens: int,
        tool: dict[str, Any] | None = None,
    ) -> ModelReply:
        model_name = model.replace("models/", "")
        url = f"{self.base_url}/models/{model_name}:generateContent"
        payload = self._build_payload(system, messages, max_tokens, tool)

        with httpx.Client(timeout=60.0) as http:
            res = http.post(url, json=payload, headers=self._headers())

        if res.status_code != 200:
            res.raise_for_status()

        return self._parse_response(res.json(), model)

    def stream(
        self,
        model: str,
        system: str,
        messages: list[Any],
        max_tokens: int,
        on_text: Callable[[str], None],
        json_mode: bool = False,
    ) -> ModelReply:
        model_name = model.replace("models/", "")
        url = f"{self.base_url}/models/{model_name}:streamGenerateContent?alt=sse"
        payload = self._build_payload(system, messages, max_tokens, None)
        if json_mode:
            # Streaming cannot use function calling, so ask for JSON output instead of free text.
            payload["generationConfig"]["responseMimeType"] = "application/json"

        accumulated_text: list[str] = []
        final_data: dict[str, Any] = {}
        other_lines: list[str] = []  # anything that is not a data event (Gemini sends errors this way)
        with httpx.Client(timeout=60.0) as http:
            with http.stream("POST", url, json=payload, headers=self._headers()) as response:
                if response.status_code != 200:
                    response.raise_for_status()
                for line in response.iter_lines():
                    if not line.startswith("data: "):
                        if line.strip():
                            other_lines.append(line)
                        continue
                    data = json.loads(line[6:])
                    if "error" in data:
                        raise _stream_error(url, data)
                    final_data = data
                    candidates = data.get("candidates") or []
                    if candidates:
                        parts = candidates[0].get("content", {}).get("parts", [])
                        for p in parts:
                            if "text" in p:
                                accumulated_text.append(p["text"])
                                on_text(p["text"])
        # An error can arrive as plain (pretty-printed) JSON in the middle of the stream: do not return a cut-off reply.
        if other_lines:
            try:
                data = json.loads("\n".join(other_lines))
            except ValueError:
                data = None
            if isinstance(data, dict) and "error" in data:
                raise _stream_error(url, data)

        usage = final_data.get("usageMetadata") or {}
        return ModelReply(
            text="".join(accumulated_text),
            input_tokens=int(usage.get("promptTokenCount", 0)),
            output_tokens=int(usage.get("candidatesTokenCount", 0)),
            model=model,
        )

    def _build_payload(
        self,
        system: str,
        messages: list[Any],
        max_tokens: int,
        tool: dict[str, Any] | None,
    ) -> dict[str, Any]:
        contents = []
        for m in messages:
            role = "model" if m.get("role") in ("assistant", "model") else "user"
            content = m.get("content") or ""
            if isinstance(content, str):
                contents.append({"role": role, "parts": [{"text": content}]})
            elif isinstance(content, list):
                parts: list[dict[str, Any]] = []
                for item in content:
                    if isinstance(item, str):
                        parts.append({"text": item})
                    elif isinstance(item, dict) and "text" in item:
                        parts.append({"text": item["text"]})
                    elif isinstance(item, dict) and item.get("type") in ("image", "document"):
                        # An Anthropic-style file block becomes Gemini's inline data.
                        source = item.get("source") or {}
                        parts.append(
                            {"inlineData": {"mimeType": source.get("media_type", ""), "data": source.get("data", "")}}
                        )
                contents.append({"role": role, "parts": parts})

        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        if tool:
            fn_decl = {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {}),
            }
            payload["tools"] = [{"functionDeclarations": [fn_decl]}]
            payload["toolConfig"] = {
                "functionCallingConfig": {
                    "mode": "ANY",
                    "allowedFunctionNames": [tool["name"]],
                }
            }
        return payload

    def _parse_response(self, data: dict[str, Any], model: str) -> ModelReply:
        candidates = data.get("candidates") or []
        text_parts: list[str] = []
        tool_input: dict[str, Any] | None = None
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            for p in parts:
                if "text" in p:
                    text_parts.append(p["text"])
                if "functionCall" in p:
                    tool_input = p["functionCall"].get("args")
        usage = data.get("usageMetadata") or {}
        return ModelReply(
            text="".join(text_parts),
            tool_input=tool_input,
            input_tokens=int(usage.get("promptTokenCount", 0)),
            output_tokens=int(usage.get("candidatesTokenCount", 0)),
            model=model,
        )


def get_client() -> Any:
    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()

    if is_gemini_active():
        if not gemini_key:
            raise AIConfigError(
                "GEMINI_API_KEY is not set. Add it to backend/.env, or set DEMO_MODE=true to try the app with sample data."
            )
        return GeminiClient(api_key=gemini_key)

    if anthropic_key:
        return Anthropic(api_key=anthropic_key, timeout=60.0, max_retries=0)

    if gemini_key:
        return GeminiClient(api_key=gemini_key)

    raise AIConfigError(
        "Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set. Add your API key to backend/.env, or set DEMO_MODE=true to try the app with sample data."
    )


def redact(text: str) -> str:
    """The text with API keys removed, for any message that may be shown to a user or written to a log."""
    for name in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY"):
        key = os.getenv(name, "").strip()
        if len(key) >= 8:
            text = text.replace(key, "[hidden]")
    return re.sub(r"([?&]key=)[^&\s'\"]+", lambda m: m.group(1) + "[hidden]", text)


# ---------- circuit breaker ----------


class _Breaker:
    def __init__(self) -> None:
        self.failures = 0
        self.open_until = 0.0
        self.lock = threading.Lock()

    def check(self) -> None:
        with self.lock:
            wait = self.open_until - time.monotonic()
        if wait > 0:
            raise AIUnavailableError(
                f"The AI service has been failing, so requests are paused. Try again in {int(wait) + 1} seconds."
            )

    def success(self) -> None:
        with self.lock:
            self.failures = 0
            self.open_until = 0.0

    def failure(self) -> None:
        with self.lock:
            self.failures += 1
            if self.failures >= BREAKER_THRESHOLD:
                self.open_until = time.monotonic() + BREAKER_SECONDS
                self.failures = 0

    def reset(self) -> None:
        self.success()


breaker = _Breaker()


# ---------- cache ----------

_cache: OrderedDict[str, tuple[float, ModelReply]] = OrderedDict()
_cache_lock = threading.Lock()


def _cache_key(task: str, model: str, system: str, messages: list[Any], tools: Any) -> str:
    blob = json.dumps([task, model, system, messages, tools], sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> ModelReply | None:
    with _cache_lock:
        item = _cache.get(key)
        if not item:
            return None
        if item[0] < time.monotonic():
            del _cache[key]
            return None
        _cache.move_to_end(key)
        return item[1]


def _cache_put(key: str, reply: ModelReply) -> None:
    ttl = cache_seconds()
    if ttl <= 0:
        return
    with _cache_lock:
        _cache[key] = (time.monotonic() + ttl, reply)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_ENTRIES:
            _cache.popitem(last=False)


def keep(reply: ModelReply) -> None:
    """Remember a reply for a while. Call this only after the answer has been checked and used, so a bad
    answer is never served from the cache."""
    if reply.cache_key and not reply.cached:
        _cache_put(reply.cache_key, reply)


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


# ---------- usage ----------


def _month_start() -> str:
    return time.strftime("%Y-%m-01 00:00:00", time.gmtime())


def tokens_used_this_month(user_id: int) -> int:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM ai_usage WHERE user_id = ? AND created_at >= ?",
            (user_id, _month_start()),
        ).fetchone()
    return int(row["n"])


def record_usage(user_id: int | None, task: str, reply: ModelReply) -> None:
    if user_id is None:
        return
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO ai_usage (user_id, task, model, input_tokens, output_tokens, cached) VALUES (?, ?, ?, ?, ?, ?)",
            (user_id, task, reply.model, reply.input_tokens, reply.output_tokens, 1 if reply.cached else 0),
        )


def check_quota(user_id: int | None) -> None:
    quota = monthly_quota()
    if user_id is None or quota <= 0:
        return
    if tokens_used_this_month(user_id) >= quota:
        raise AIQuotaError(
            f"You have used this month's AI allowance ({quota:,} tokens). It resets at the start of next month."
        )


# ---------- calling the model ----------


def _retryable(exc: Exception) -> bool:
    if isinstance(exc, RateLimitError | APIConnectionError):
        return True
    if isinstance(exc, APIStatusError) and exc.status_code in (429, 500, 502, 503, 529):
        return True
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (429, 500, 502, 503, 529):
        return True
    return False


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _reply_from(response: Any, model: str) -> ModelReply:
    text, tool_input = [], None
    for block in getattr(response, "content", None) or []:
        kind = getattr(block, "type", "")
        if kind == "text":
            text.append(block.text)
        elif kind == "tool_use" and isinstance(getattr(block, "input", None), dict):
            tool_input = block.input
    usage = getattr(response, "usage", None)
    return ModelReply(
        text="".join(text),
        tool_input=tool_input,
        input_tokens=_int(getattr(usage, "input_tokens", 0)),
        output_tokens=_int(getattr(usage, "output_tokens", 0)),
        model=model,
    )


def _one_call(client: Any, model: str, kwargs: dict[str, Any], on_text: Callable[[str], None] | None) -> ModelReply:
    if isinstance(client, GeminiClient):
        if on_text is not None:
            return client.stream(
                model,
                kwargs.get("system", ""),
                kwargs.get("messages", []),
                kwargs.get("max_tokens", 4000),
                on_text,
                json_mode=bool(kwargs.get("tool")),
            )
        tool = kwargs.get("tool")
        return client.generate(
            model, kwargs.get("system", ""), kwargs.get("messages", []), kwargs.get("max_tokens", 4000), tool
        )

    # Anthropic or mock client
    anthropic_kwargs = {k: v for k, v in kwargs.items() if k != "tool"}
    if on_text is None:
        return _reply_from(client.messages.create(model=model, **anthropic_kwargs), model)
    anthropic_kwargs = {k: v for k, v in anthropic_kwargs.items() if k not in ("tools", "tool_choice")}
    with client.messages.stream(model=model, **anthropic_kwargs) as stream:
        for piece in stream.text_stream:
            on_text(piece)
        return _reply_from(stream.get_final_message(), model)


def call_model(
    client: Any,
    task: str,
    system: str,
    messages: list[Any],
    max_tokens: int,
    *,
    tool: dict[str, Any] | None = None,
    user_id: int | None = None,
    on_text: Callable[[str], None] | None = None,
    use_cache: bool = True,
) -> ModelReply:
    """One model call with retries, the fallback model, the breaker, the cache and usage accounting.

    With `tool` the model is asked to answer by calling that tool, and the arguments come back in
    `reply.tool_input` (structured output). Without it the answer is in `reply.text`.
    """
    primary = model_for(task)
    key = _cache_key(task, primary, system, messages, tool)
    if use_cache and on_text is None:
        hit = _cache_get(key)
        if hit:
            cached = ModelReply(
                **{**hit.__dict__, "cached": True, "input_tokens": 0, "output_tokens": 0, "cache_key": ""}
            )
            record_usage(user_id, task, cached)
            return cached

    check_quota(user_id)
    breaker.check()

    kwargs: dict[str, Any] = {"max_tokens": max_tokens, "system": system, "messages": messages, "tool": tool}
    if tool:
        kwargs["tools"] = [tool]
        kwargs["tool_choice"] = {"type": "tool", "name": tool["name"]}

    models = [primary] + ([fallback_model()] if fallback_model() and fallback_model() != primary else [])
    last: Exception | None = None
    primary_error: Exception | None = None
    for model in models:
        for attempt in range(RETRIES):
            try:
                reply = _one_call(client, model, kwargs, on_text)
            except (APIError, httpx.HTTPError) as exc:
                last = exc
                if not _retryable(exc):
                    if model != primary:
                        break  # an unusable fallback model must not hide why the main model failed
                    breaker.failure()
                    raise AIGenerationError(f"AI service request failed: {redact(str(exc))}") from exc
                if model == primary:
                    primary_error = exc
                if attempt < RETRIES - 1:
                    time.sleep(BASE_DELAY * (2**attempt))
                continue
            breaker.success()
            if use_cache and on_text is None:
                reply.cache_key = key
            record_usage(user_id, task, reply)
            return reply
    breaker.failure()
    raise AIGenerationError(
        f"AI service is busy or unreachable after several tries: {redact(str(primary_error or last))}"
    )
