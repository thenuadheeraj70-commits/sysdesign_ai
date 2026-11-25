"""Phase 5: streaming a reply as it is written, with the Anthropic client and the Gemini adapter."""

import json
from contextlib import contextmanager
from types import SimpleNamespace

import httpx
import pytest

from app import config
from app.services import ai_core
from app.services.ai_core import AIGenerationError, GeminiClient, call_model
from app.services.ai_generator import generate_architecture_ex

GOOD = {
    "project_name": "Shop",
    "description": "A shop.",
    "components": [
        {"id": "api", "name": "API", "type": "compute", "provider": "aws"},
        {"id": "db", "name": "DB", "type": "database", "provider": "aws"},
    ],
    "connections": [{"source": "api", "target": "db", "label": "sql"}],
    "assumptions": [],
}


class StreamingFake:
    """An Anthropic-style client whose `messages.stream` yields the text in pieces."""

    def __init__(self, text, tokens=(5, 9)):
        self.text, self.tokens, self.calls = text, tokens, []
        self.messages = SimpleNamespace(stream=self._stream, create=self._no_create)

    def _no_create(self, **kw):
        raise AssertionError("a streaming call must not use messages.create")

    @contextmanager
    def _stream(self, **kwargs):
        self.calls.append(kwargs)
        pieces = [self.text[i : i + 40] for i in range(0, len(self.text), 40)]
        final = SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self.text)],
            usage=SimpleNamespace(input_tokens=self.tokens[0], output_tokens=self.tokens[1]),
        )
        yield SimpleNamespace(text_stream=iter(pieces), get_final_message=lambda: final)


@pytest.fixture
def live(monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", False)


def test_streaming_reports_each_piece_and_returns_the_parsed_design(live):
    fake = StreamingFake(json.dumps(GOOD))
    pieces = []
    arch, cached = generate_architecture_ex("shop", fake, on_text=pieces.append)
    assert arch.project_name == "Shop" and cached is False
    assert len(pieces) > 1 and "".join(pieces) == json.dumps(GOOD)


def test_a_streaming_call_asks_for_plain_text_not_a_tool(live):
    fake = StreamingFake(json.dumps(GOOD))
    generate_architecture_ex("shop", fake, on_text=lambda _: None)
    assert "tools" not in fake.calls[0] and "tool_choice" not in fake.calls[0] and "tool" not in fake.calls[0]


def test_streamed_answers_are_never_cached(live):
    fake = StreamingFake(json.dumps(GOOD))
    generate_architecture_ex("shop", fake, on_text=lambda _: None)
    generate_architecture_ex("shop", fake, on_text=lambda _: None)
    assert len(fake.calls) == 2


def test_a_streamed_answer_that_is_not_a_design_is_retried_then_refused(live):
    fake = StreamingFake("sorry, no")
    with pytest.raises(AIGenerationError, match="invalid architecture"):
        generate_architecture_ex("shop", fake, on_text=lambda _: None)
    assert len(fake.calls) == 2


# ---------- the Gemini adapter ----------


class FakeHttp:
    """Stands in for httpx.Client: returns a prepared response and remembers what was sent."""

    sent: list = []
    json_body: dict = {}
    lines: list = []
    status = 200

    def __init__(self, *a, **k): ...
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, url, json=None, headers=None):
        FakeHttp.sent.append((url, json, headers))
        return httpx.Response(FakeHttp.status, json=FakeHttp.json_body, request=httpx.Request("POST", url))

    @contextmanager
    def stream(self, method, url, json=None, headers=None):
        FakeHttp.sent.append((url, json, headers))
        response = SimpleNamespace(
            status_code=FakeHttp.status,
            raise_for_status=lambda: (_ for _ in ()).throw(
                httpx.HTTPStatusError(
                    "bad", request=httpx.Request(method, url), response=httpx.Response(FakeHttp.status)
                )
            ),
            iter_lines=lambda: iter(FakeHttp.lines),
        )
        yield response


@pytest.fixture
def gemini(monkeypatch):
    FakeHttp.sent, FakeHttp.status, FakeHttp.json_body, FakeHttp.lines = [], 200, {}, []
    monkeypatch.setattr(httpx, "Client", FakeHttp)
    return GeminiClient("secret-key-123")


def chunk(text, usage=None):
    body = {"candidates": [{"content": {"parts": [{"text": text}]}}]}
    if usage:
        body["usageMetadata"] = usage
    return "data: " + json.dumps(body)


def test_gemini_streams_text_and_counts_tokens(gemini):
    FakeHttp.lines = [
        "",
        chunk('{"project_'),
        chunk('name": "X"}', {"promptTokenCount": 12, "candidatesTokenCount": 34}),
    ]
    pieces = []
    reply = gemini.stream("gemini-x", "sys", [{"role": "user", "content": "hi"}], 100, pieces.append)
    assert pieces == ['{"project_', 'name": "X"}'] and reply.text == '{"project_name": "X"}'
    assert (reply.input_tokens, reply.output_tokens) == (12, 34)
    url, body, headers = FakeHttp.sent[0]
    assert url.endswith(":streamGenerateContent?alt=sse") and "secret-key-123" not in url
    assert headers["x-goog-api-key"] == "secret-key-123" and "tools" not in body


def test_gemini_streaming_failure_status_is_raised(gemini):
    FakeHttp.status = 503
    with pytest.raises(httpx.HTTPStatusError):
        gemini.stream("gemini-x", "s", [{"role": "user", "content": "x"}], 10, lambda _: None)


def test_gemini_failure_status_on_a_plain_call_is_raised(gemini):
    FakeHttp.status = 429
    with pytest.raises(httpx.HTTPStatusError):
        gemini.generate("gemini-x", "s", [{"role": "user", "content": "x"}], 10)


def test_a_design_comes_back_through_gemini_function_calling(gemini, live):
    FakeHttp.json_body = {
        "candidates": [{"content": {"parts": [{"functionCall": {"name": "submit_architecture", "args": GOOD}}]}}],
        "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 8},
    }
    arch, _ = generate_architecture_ex("shop", gemini)
    assert [c.id for c in arch.components] == ["api", "db"]
    _, body, _ = FakeHttp.sent[0]
    declaration = body["tools"][0]["functionDeclarations"][0]
    assert declaration["name"] == "submit_architecture" and body["toolConfig"]["functionCallingConfig"]["mode"] == "ANY"


def test_gemini_overload_is_retried_like_any_other_service(gemini, monkeypatch):
    calls = []

    def flaky(self, url, json=None, headers=None):
        calls.append(url)
        status = 503 if len(calls) < 3 else 200
        body = {"candidates": [{"content": {"parts": [{"text": "ok"}]}}]}
        return httpx.Response(status, json=body, request=httpx.Request("POST", url))

    monkeypatch.setattr(FakeHttp, "post", flaky)
    reply = call_model(gemini, "generation", "s", [{"role": "user", "content": "x"}], 10)
    assert reply.text == "ok" and len(calls) == 3


def test_a_gemini_timeout_is_retryable_and_a_400_is_not(gemini, monkeypatch):
    assert ai_core._retryable(httpx.ReadTimeout("slow"))
    assert ai_core._retryable(httpx.ConnectError("down"))
    bad = httpx.HTTPStatusError("x", request=httpx.Request("POST", "http://x"), response=httpx.Response(400))
    assert not ai_core._retryable(bad)
    assert not ai_core._retryable(ValueError("nope"))


def test_the_settings_summary_names_the_provider(monkeypatch):
    assert ai_core.settings_summary()["provider"] == "anthropic"
    monkeypatch.setenv("GEMINI_API_KEY", "g-key-123456")
    summary = ai_core.settings_summary()
    assert summary["provider"] == "gemini" and set(summary["models"]) == set(ai_core.TASKS)


def test_gemini_error_sent_inside_the_stream_is_raised_not_returned_as_a_cut_off_answer(gemini):
    FakeHttp.lines = [
        chunk('{"project_name": "X", "comp'),
        "{",
        '  "error": {',
        '    "code": 503,',
        '    "message": "This model is currently experiencing high demand.",',
        '    "status": "UNAVAILABLE"',
        "  }",
        "}",
    ]
    with pytest.raises(httpx.HTTPStatusError) as exc:
        gemini.stream("gemini-x", "s", [{"role": "user", "content": "x"}], 10, lambda _: None)
    assert exc.value.response.status_code == 503 and ai_core._retryable(exc.value)


def test_gemini_error_as_a_data_event_is_raised_too(gemini):
    FakeHttp.lines = ["data: " + json.dumps({"error": {"code": 429, "message": "slow down"}})]
    with pytest.raises(httpx.HTTPStatusError) as exc:
        gemini.stream("gemini-x", "s", [{"role": "user", "content": "x"}], 10, lambda _: None)
    assert exc.value.response.status_code == 429


def test_a_mid_stream_overload_is_retried_on_the_fallback_model(gemini, monkeypatch):
    monkeypatch.setenv("AI_MODEL_GENERATION", "busy-model")
    monkeypatch.setenv("AI_FALLBACK_MODEL", "stable-model")
    seen = []

    def lines_for(url):
        seen.append(url)
        if "busy-model" in url:
            return ["{", '  "error": {"code": 503, "message": "high demand"}', "}"]
        return [chunk("done")]

    original = FakeHttp.stream

    def stream(self, method, url, json=None, headers=None):
        FakeHttp.lines = lines_for(url)
        return original(self, method, url, json=json, headers=headers)

    monkeypatch.setattr(FakeHttp, "stream", stream)
    pieces = []
    reply = call_model(gemini, "generation", "s", [{"role": "user", "content": "x"}], 10, on_text=pieces.append)
    assert reply.text == "done" and reply.model == "stable-model" and pieces == ["done"]
    assert sum("busy-model" in u for u in seen) == ai_core.RETRIES


def test_streaming_a_design_asks_gemini_for_json_output(gemini, live):
    FakeHttp.lines = [chunk(json.dumps(GOOD))]
    arch, _ = generate_architecture_ex("shop", gemini, on_text=lambda _: None)
    assert [c.id for c in arch.components] == ["api", "db"]
    _, body, _ = FakeHttp.sent[0]
    assert body["generationConfig"]["responseMimeType"] == "application/json" and "tools" not in body


def test_images_and_pdfs_are_sent_to_gemini_as_inline_data(gemini):
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
                {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": "BBBB"}},
                {"type": "text", "text": "Describe the system."},
            ],
        }
    ]
    parts = gemini._build_payload("s", messages, 10, None)["contents"][0]["parts"]
    assert parts[0] == {"inlineData": {"mimeType": "image/png", "data": "AAAA"}}
    assert parts[1] == {"inlineData": {"mimeType": "application/pdf", "data": "BBBB"}}
    assert parts[2] == {"text": "Describe the system."}


def test_startup_messages_accept_either_key(monkeypatch):
    monkeypatch.setattr(config, "DEMO_MODE", False)
    assert any("No AI key" in text for _, text in config.startup_messages())
    monkeypatch.setenv("GEMINI_API_KEY", "g-key-123456")
    assert not any("key" in text.lower() and "AI" in text for _, text in config.startup_messages())


def test_an_unusable_fallback_model_does_not_hide_the_main_models_error(gemini, monkeypatch):
    monkeypatch.setenv("AI_MODEL_GENERATION", "busy-model")
    monkeypatch.setenv("AI_FALLBACK_MODEL", "missing-model")

    def post(self, url, json=None, headers=None):
        status = 503 if "busy-model" in url else 404
        return httpx.Response(status, json={}, request=httpx.Request("POST", url))

    monkeypatch.setattr(FakeHttp, "post", post)
    with pytest.raises(AIGenerationError) as exc:
        call_model(gemini, "generation", "s", [{"role": "user", "content": "x"}], 10)
    assert "503" in str(exc.value) and "404" not in str(exc.value)
