"""Smoke tests for the SiskelBot Python SDK using httpx.MockTransport."""

from __future__ import annotations

import json

import httpx
import pytest

from siskelbot import SiskelBotClient, SiskelBotError


def _client_with_transport(transport: httpx.MockTransport) -> SiskelBotClient:
    """Build a client whose internal httpx.Client uses the mock transport.

    We do this by monkeypatching `httpx.Client` to inject `transport=` for tests.
    """
    real_client_cls = httpx.Client

    class _PatchedClient(real_client_cls):  # type: ignore[misc]
        def __init__(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            kwargs.setdefault("transport", transport)
            super().__init__(*args, **kwargs)

    httpx.Client = _PatchedClient  # type: ignore[misc]
    client = SiskelBotClient(base_url="http://test", api_key="k", max_retries=1)
    return client


def test_chat_completion_success(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        assert body["messages"][0]["content"] == "hi"
        assert body["stream"] is False
        return httpx.Response(
            200,
            json={
                "id": "x",
                "choices": [{"message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}],
            },
        )

    transport = httpx.MockTransport(handler)
    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: real(*a, transport=transport, **k))

    client = SiskelBotClient(base_url="http://test", api_key="k", max_retries=0)
    result = client.chat_completion(messages=[{"role": "user", "content": "hi"}])
    assert result["choices"][0]["message"]["content"] == "hello"


def test_health_deep(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health/deep"
        return httpx.Response(200, json={"status": "up", "dependencies": []})

    transport = httpx.MockTransport(handler)
    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: real(*a, transport=transport, **k))

    client = SiskelBotClient(base_url="http://test", max_retries=0)
    result = client.health_deep()
    assert result["status"] == "up"


def test_error_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="bad")

    transport = httpx.MockTransport(handler)
    real = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: real(*a, transport=transport, **k))

    client = SiskelBotClient(base_url="http://test", max_retries=0)
    with pytest.raises(SiskelBotError) as exc_info:
        client.health_deep()
    assert exc_info.value.status == 400
    assert exc_info.value.retryable is False
