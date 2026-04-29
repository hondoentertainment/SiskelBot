# SDKs

SiskelBot ships official client libraries for TypeScript/Node.js and Python. Both
live under [`sdk/`](../sdk/) in this repo and are versioned together with the
server.

| Language | Package | Path | Min runtime |
|----------|---------|------|-------------|
| TypeScript / Node.js | `@siskelbot/sdk` | [`sdk/typescript/`](../sdk/typescript/) | Node 18+ |
| Python | `siskelbot` | [`sdk/python/`](../sdk/python/) | Python 3.9+ |

Both clients implement the same conventions:

- Typed surface (TypeScript types / Python type hints).
- One-shot and streaming chat completions over SSE.
- Automatic retries on `5xx` and `429` with exponential backoff
  (`2^attempt * 500ms` in TS, `2^attempt * 0.5s` in Python).
- Configurable per-request timeout.
- Dedicated error class (`SiskelBotError`) with `status`, `code`, and
  `retryable` fields.
- Bearer-token auth via the `apiKey` / `api_key` constructor option.

The OpenAPI spec the SDKs are aligned to is generated from the running server:

```bash
npm run openapi:generate
```

The TypeScript surface in `sdk/typescript/src/index.ts` is hand-curated for
ergonomics; full type coverage of every endpoint can be regenerated through
`scripts/generate-sdk.mjs` (run via `npm run build:sdk`).

## TypeScript SDK

### Install

```bash
npm install @siskelbot/sdk
```

### Quick start

```typescript
import { SiskelBotClient } from "@siskelbot/sdk";

const client = new SiskelBotClient({
  baseUrl: "https://siskelbot.example.com",
  apiKey: process.env.SISKELBOT_API_KEY,
  timeoutMs: 30_000,
  maxRetries: 3,
});

const res = await client.chat.completions({
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(res.choices[0].message.content);
```

### Streaming

```typescript
const stream = await client.chat.stream({
  messages: [{ role: "user", content: "Tell me a story." }],
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### Build

```bash
cd sdk/typescript
npm install
npm run build
```

This emits `dist/index.js` and `dist/index.d.ts` (plus declaration maps).

## Python SDK

### Install

```bash
pip install siskelbot
```

### Quick start

```python
from siskelbot import SiskelBotClient

client = SiskelBotClient(
    base_url="https://siskelbot.example.com",
    api_key="...",
    timeout=30.0,
    max_retries=3,
)

result = client.chat_completion(
    messages=[{"role": "user", "content": "Hello!"}],
)
print(result["choices"][0]["message"]["content"])
```

### Streaming

```python
for chunk in client.chat_stream(
    messages=[{"role": "user", "content": "Tell me a story."}],
):
    delta = chunk["choices"][0].get("delta", {})
    print(delta.get("content", ""), end="", flush=True)
```

### Build

```bash
cd sdk/python
pip install -e .
```

The wheel and sdist are produced via [`hatchling`](https://hatch.pypa.io/):

```bash
cd sdk/python
pip install build
python -m build  # writes dist/siskelbot-*.whl and dist/siskelbot-*.tar.gz
```

## Publishing

Both SDKs share the server version. When cutting a release:

1. Bump the version in both `sdk/typescript/package.json` and
   `sdk/python/pyproject.toml` (and `sdk/python/src/siskelbot/__init__.py`'s
   `__version__`).
2. Tag the repo (e.g. `git tag sdk-v0.1.0 && git push --tags`).
3. Publish to npm and PyPI as below.

### npm

```bash
cd sdk/typescript
npm install
npm run build
# Sanity check the tarball before publishing
npm pack --dry-run
# Real publish (requires npm 2FA + access to the @siskelbot scope)
npm publish --access public
```

The `files` whitelist in `package.json` keeps the published tarball to
`dist/`, `README.md`, and `LICENSE` only — no source, tests, or tsconfig.

### PyPI

```bash
cd sdk/python
pip install --upgrade build twine
python -m build
# Sanity check
twine check dist/*
# Real publish
twine upload dist/*
```

For dry runs, target the test index first:

```bash
twine upload --repository testpypi dist/*
```

### CI publish (recommended)

In CI, prefer trusted-publisher tokens over long-lived credentials:

- npm: provisioned via OIDC (`npm publish` from a workflow with
  `id-token: write`).
- PyPI: configured via [trusted publishing](https://docs.pypi.org/trusted-publishers/).

Wire both into a release workflow that runs only on `sdk-v*` tags.

## Versioning policy

- **MAJOR** version bumps for breaking changes to the SDK surface (renamed
  methods, removed fields).
- **MINOR** for new endpoints or optional parameters.
- **PATCH** for bug fixes and dependency updates.

Server API versioning (v1 vs v2) is independent — the SDK exposes both via
namespaced methods (`client.chat.*` for v1; future v2 namespaces under
`client.v2.*`).

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `SiskelBotError: HTTP 401` | Missing or invalid `apiKey` / `api_key`. |
| `SiskelBotError: HTTP 429` retried then thrown | Rate limit; raise `maxRetries` or back off. |
| Stream hangs | Server not emitting SSE; check `Accept: text/event-stream` reaches the proxy. |
| `fetch is not defined` (Node) | Node < 18; upgrade or polyfill via the `fetch` constructor option. |

## See also

- [`sdk/typescript/README.md`](../sdk/typescript/README.md)
- [`sdk/python/README.md`](../sdk/python/README.md)
- [`scripts/generate-sdk.mjs`](../scripts/generate-sdk.mjs) — full-spec generator
- [`lib/openapi-spec.js`](../lib/openapi-spec.js) — input schema
