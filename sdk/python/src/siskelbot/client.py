"""Python client for SiskelBot."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator, Iterator, Optional

import httpx


class SiskelBotError(Exception):
    def __init__(self, message: str, status: int, code: str = "HTTP_ERROR", retryable: bool = False):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable


class SiskelBotClient:
    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 3,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        last_err: Optional[Exception] = None
        for attempt in range(self.max_retries + 1):
            try:
                with httpx.Client(timeout=self.timeout) as c:
                    r = c.request(method, f"{self.base_url}{path}", headers=self._headers(), json=body)
                    if r.is_success:
                        return r.json()
                    retryable = r.status_code >= 500 or r.status_code == 429
                    err = SiskelBotError(f"HTTP {r.status_code}: {r.text}", r.status_code, retryable=retryable)
                    if not retryable or attempt == self.max_retries:
                        raise err
                    last_err = err
            except (httpx.RequestError, httpx.TimeoutException) as e:
                last_err = e
                if attempt == self.max_retries:
                    raise
            time.sleep(2 ** attempt * 0.5)
        if last_err:
            raise last_err

    def chat_completion(
        self,
        messages: list[dict],
        model: Optional[str] = None,
        workspace: Optional[str] = None,
        **kwargs: Any,
    ) -> dict:
        body = {"messages": messages, "stream": False, **kwargs}
        if model:
            body["model"] = model
        if workspace:
            body["workspace"] = workspace
        return self._request("POST", "/v1/chat/completions", body)

    def chat_stream(
        self,
        messages: list[dict],
        model: Optional[str] = None,
        workspace: Optional[str] = None,
        **kwargs: Any,
    ) -> Iterator[dict]:
        body = {"messages": messages, "stream": True, **kwargs}
        if model:
            body["model"] = model
        if workspace:
            body["workspace"] = workspace
        with httpx.Client(timeout=None) as c:
            with c.stream("POST", f"{self.base_url}/v1/chat/completions", headers=self._headers(), json=body) as r:
                if not r.is_success:
                    raise SiskelBotError(f"HTTP {r.status_code}", r.status_code)
                for line in r.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        yield json.loads(data)
                    except json.JSONDecodeError:
                        continue

    def health_deep(self) -> dict:
        return self._request("GET", "/health/deep")
