# siskelbot

Official Python SDK for [SiskelBot](https://github.com/hondoentertainment/SiskelBot).

## Install

```bash
pip install siskelbot
```

Requires Python 3.9+.

## Quick start

```python
from siskelbot import SiskelBotClient

client = SiskelBotClient(
    base_url="https://siskelbot.example.com",
    api_key="...",
)

# One-shot chat completion
result = client.chat_completion(
    messages=[{"role": "user", "content": "Hello!"}],
)
print(result["choices"][0]["message"]["content"])
```

## Streaming

```python
for chunk in client.chat_stream(
    messages=[{"role": "user", "content": "Tell me a story."}],
):
    delta = chunk["choices"][0].get("delta", {})
    print(delta.get("content", ""), end="", flush=True)
```

## Error handling

All HTTP errors are raised as `SiskelBotError`:

```python
from siskelbot import SiskelBotClient, SiskelBotError

try:
    client.chat_completion(messages=[{"role": "user", "content": "hi"}])
except SiskelBotError as e:
    print(f"HTTP {e.status} ({e.code}): {e}")
    if e.retryable:
        # 5xx or 429 — already retried internally up to max_retries
        pass
```

## Retries

The client retries automatically on `5xx` and `429` responses with exponential
backoff (`2^attempt * 0.5s`). Configure with `max_retries` (default `3`) and
`timeout` (default `30.0` seconds).

```python
client = SiskelBotClient(
    base_url="https://siskelbot.example.com",
    api_key="...",
    timeout=60.0,
    max_retries=5,
)
```

## Other endpoints

```python
# Deep health check
health = client.health_deep()
print(health["status"])  # "up" | "degraded" | "down"
```

## Building from source

```bash
cd sdk/python
pip install -e .
```

## License

MIT — see [../LICENSE](../LICENSE).

## See also

- Main repo: [hondoentertainment/SiskelBot](https://github.com/hondoentertainment/SiskelBot)
- TypeScript SDK: [`sdk/typescript/`](../typescript/)
