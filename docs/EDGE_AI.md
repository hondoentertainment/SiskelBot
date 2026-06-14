# Edge AI inference (Phase 40.4)

SiskelBot can offload short, latency-sensitive chat and embedding
requests to a small model running at the edge — Cloudflare Workers AI
or a Fastly Compute@Edge inference backend — instead of round-tripping
to the origin Express server. This document covers when to use it,
which models are available on each platform, and how to deploy and
monitor the split.

## Why edge AI

| Driver | Origin only | With edge AI |
|--------|-------------|--------------|
| First-token latency for short prompts | 200-800ms (origin region) | 30-150ms (POP local) |
| Cost per simple prompt | full model bill | included in CDN compute |
| Origin CPU on burst traffic | 100% spike | absorbed at the POP |
| Availability for "what's the weather" -style asks | depends on origin | survives origin outages |

The router is intentionally conservative. It only sends a request to
the edge if the prompt is short, single-turn, contains no tool calls
or code, and is not requesting a structured output. Anything else
falls through to the origin, which has access to larger models, tool
execution, knowledge base context, and the agent loop.

## When to use it

Good fits for the edge:

- Short single-turn questions (< 2000 chars total prompt).
- Embedding requests for incoming search queries.
- Chat clients in regions far from the origin (Asia, Oceania).
- Chat UIs that want a cheap "instant" response while the full agent
  is still spinning up on the origin.

Bad fits — these always go to origin:

- Multi-turn conversations (>= 6 messages).
- Anything that uses `tools` / `functions` / `tool_choice`.
- Requests with `response_format: { type: "json_object" }`.
- Streaming chat (`stream: true`) — Workers AI does not currently
  return clean SSE through `fetch`.
- Code-heavy prompts (presence of triple-backtick fences).
- Prompts containing SQL DDL/DML keywords.

The exact heuristic is implemented in three places that must stay in
sync:

| Layer | File |
|-------|------|
| Server router | `lib/edge-ai-router.js` (`analyzeComplexity`) |
| Cloudflare worker | `edge/ai/cloudflare-ai-worker.js` (`analyzeComplexity`) |
| Fastly compute  | `edge/ai/fastly-compute.js` (`analyzeComplexity`) |

## Supported models per platform

### Cloudflare Workers AI

Chat:

- `@cf/meta/llama-3-8b-instruct` (default)
- `@cf/mistral/mistral-7b-instruct-v0.2` (fallback)
- `@cf/google/gemma-7b-it`
- `@cf/qwen/qwen1.5-7b-chat-awq`

Embeddings:

- `@cf/baai/bge-base-en-v1.5` (default, 768-dim)
- `@cf/baai/bge-small-en-v1.5` (384-dim)
- `@cf/baai/bge-large-en-v1.5` (1024-dim)

### Fastly Compute@Edge

Fastly does not host models directly. The Fastly worker forwards
"simple" requests to a regional inference backend (`inference_origin`)
declared in `fastly.toml` — typically a small Ollama or vLLM cluster
in each region. Model IDs in `lib/edge-ai-router.js` are namespaced as
`fastly/...` so the router can pick a default.

## Cost comparison (rough)

| Path | Cost per 1k simple chat requests | Notes |
|------|----------------------------------|-------|
| Origin (OpenAI gpt-4o-mini) | ~$0.15 | + origin CPU + bandwidth |
| Origin (vLLM, self-hosted)  | ~$0.02 | + GPU amortisation |
| Cloudflare Workers AI       | ~$0.011 | first 10k/day free |
| Fastly + regional vLLM      | ~$0.02 | + Compute@Edge invocation |

Numbers are illustrative — verify against your actual Cloudflare /
Fastly invoices and your origin model pricing before relying on them.

## Deployment

### Cloudflare

```bash
cd edge/ai
wrangler login
wrangler deploy --config wrangler.toml
```

The worker requires the `[ai]` binding (already in
`edge/ai/wrangler.toml`) and an `ORIGIN_URL` var pointing at your
Express origin. The route pattern in the file is
`ai.siskelbot.example.com/*` — replace it with your zone before
deploying.

Verify the worker is live:

```bash
curl -X POST https://ai.siskelbot.example.com/v1/chat/completions/edge \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
```

The response should include `X-Edge: cloudflare` and
`X-Edge-AI: hit` headers.

### Fastly

```bash
cd edge/ai
fastly compute build
fastly compute deploy
```

You will need a `fastly.toml` declaring `siskelbot_origin` and
`inference_origin` backends. See `docs/EDGE_DEPLOYMENT.md` for the
existing Fastly VCL setup; the Compute@Edge variant lives alongside
it and uses the same backend names.

### Server-side router

To make the origin server route eligible traffic through the edge,
set:

```bash
export EDGE_AI_PROVIDER=cloudflare
export EDGE_AI_URL=https://ai.siskelbot.example.com
export EDGE_AI_ENABLED=1
```

Optional overrides:

| Var | Default | Purpose |
|-----|---------|---------|
| `EDGE_AI_TIMEOUT_MS` | `5000` | Abort the edge call if it doesn't return in time |
| `EDGE_AI_CHAT_PATH` | `/v1/chat/completions/edge` | Override worker chat path |
| `EDGE_AI_EMBED_PATH` | `/api/v1/embeddings/edge` | Override worker embedding path |

## Monitoring edge vs origin

Every edge response carries observability headers:

| Header | Values | Meaning |
|--------|--------|---------|
| `X-Edge` | `cloudflare`, `fastly` | Which POP runtime served the response |
| `X-Edge-AI` | `hit`, `skip`, `error` | Whether the edge model actually answered |
| `X-Edge-Model` | model id | Which edge model was used (when `hit`) |
| `X-Edge-Complexity` | `0.000`-`1.000` | Score from the complexity heuristic |
| `X-Edge-AI-Reason` | string | Why the edge skipped (e.g. `too_complex`) |

The origin server reads these on the response from `routeToEdgeAI`
and emits them as Prometheus metrics:

- `siskelbot_edge_ai_requests_total{provider, kind, status}`
- `siskelbot_edge_ai_complexity_bucket`
- `siskelbot_edge_ai_latency_ms_bucket{provider}`

A Grafana dashboard panel "Edge AI vs Origin split" lives in
`grafana/edge-ai.json` (template) and groups by `provider` and
`status`. Alert when `status="error"` exceeds 5% of total over 5 min.

## Local development

The Cloudflare worker can be run locally with:

```bash
cd edge/ai
wrangler dev --local
```

Without an `[ai]` binding, the local worker will respond `skip` and
proxy to the origin — useful for end-to-end tests without burning
real Workers AI minutes.

The Fastly module is importable directly from Node for unit tests:

```bash
node --test tests/edge-ai-router.test.js
```
