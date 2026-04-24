# Backend Configuration

SiskelBot is a streaming proxy that can front Ollama, vLLM, or OpenAI. This document covers how to configure each backend, the smart routing system, A/B routing, and the circuit breaker.

## Overview

The active backend is selected with the `BACKEND` environment variable:

| Value | Description |
|---|---|
| `openai` | OpenAI API (or any OpenAI-compatible endpoint) |
| `ollama` | Local or networked Ollama server |
| `vllm` | vLLM inference server |

The default in `.env.example` is `ollama`. Change it to match your deployment.

---

## OpenAI

```bash
BACKEND=openai
OPENAI_API_KEY=sk-...
MODEL=gpt-4o

# Optional: override the API base to use a compatible provider
# (Azure OpenAI, Together AI, Groq, Fireworks, etc.)
OPENAI_BASE_URL=https://api.openai.com/v1
```

`OPENAI_BASE_URL` lets you point SiskelBot at any OpenAI-compatible API without changing the rest of the configuration. For example, to use Groq:

```bash
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_API_KEY=gsk_...
MODEL=llama-3.3-70b-versatile
```

---

## Ollama

```bash
BACKEND=ollama
OLLAMA_URL=http://localhost:11434
MODEL=llama3.2
```

Pull the model before starting SiskelBot:

```bash
ollama pull llama3.2
```

### Ollama on Kubernetes

If Ollama runs in-cluster, set `OLLAMA_URL` to the cluster-internal DNS name:

```bash
OLLAMA_URL=http://ollama.ollama.svc.cluster.local:11434
```

Minimal Ollama Deployment (key parts):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ollama
  namespace: ollama
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ollama
  template:
    spec:
      containers:
        - name: ollama
          image: ollama/ollama:latest
          ports:
            - containerPort: 11434
          volumeMounts:
            - name: models
              mountPath: /root/.ollama
      volumes:
        - name: models
          persistentVolumeClaim:
            claimName: ollama-models
```

---

## vLLM

```bash
BACKEND=vllm
VLLM_URL=http://vllm:8000
MODEL=meta-llama/Llama-3.1-8B-Instruct
```

Start vLLM with:

```bash
vllm serve meta-llama/Llama-3.1-8B-Instruct \
  --host 0.0.0.0 --port 8000 \
  --gpu-memory-utilization 0.9
```

vLLM exposes an OpenAI-compatible API, so `BACKEND=openai` with `OPENAI_BASE_URL=http://vllm:8000/v1` also works if you prefer not to set `VLLM_URL`.

---

## Smart Routing

Smart routing selects between multiple candidate models based on live quality, cost, and latency metrics collected from actual traffic. It extends A/B routing (see below) with quality-aware strategies.

### Enabling smart routing

Set `MODEL_ROUTING` to a comma-separated list of `backend:weight` pairs — the same format as A/B routing (see next section). Then configure the routing strategy via your application or tooling that calls `selectSmartBackend` from `lib/smart-router.js`.

### Strategies

`selectSmartBackend(candidates, strategy, options)` supports:

| Strategy | Behavior |
|---|---|
| `quality` | Picks the candidate with the highest composite quality score (default) |
| `cost` | Picks the cheapest candidate based on `MODEL_COSTS` |
| `latency` | Picks the candidate with the lowest p50 latency |
| `round-robin` | Cycles through candidates in order |
| `weighted` | Probabilistic selection proportional to explicit weights |

When no quality data has been collected yet, the router falls back to the first candidate.

### Quality metrics

Quality scores are maintained by `lib/model-quality.js`. Each model is scored on a 0–100 scale from:

- **Error rate** (weight: 40 points) — fraction of failed responses
- **Latency** (weight: 30 points) — p50 latency normalised against a ceiling
- **Throughput** (weight: 20 points) — tokens/sec normalised against a ceiling
- **User satisfaction** (weight: 10 points) — optional explicit ratings

Scores accumulate as traffic flows through the system; they are available via `getModelRanking()` and the smart router will log a `model_promotion_recommendation` event to stdout when a candidate outperforms the current default by 10+ points across at least 100 samples.

### Cost configuration

```bash
# Format: "model:cost_per_1k_tokens,model:cost_per_1k_tokens"
MODEL_COSTS=gpt-4o:0.06,gpt-4o-mini:0.002,llama3.2:0
```

---

## A/B Routing

A/B routing splits traffic across backends using weighted random selection keyed on request ID, so the same request ID always goes to the same backend (deterministic).

### Configuration

```bash
# Format: "backend:weight,backend:weight"
# Weights are normalised automatically — they don't have to sum to 1.
MODEL_ROUTING=ollama:0.8,openai:0.2
```

This sends 80% of traffic to Ollama and 20% to OpenAI. The router automatically skips any backend whose circuit breaker is open and re-normalises the remaining weights.

### Canary-testing a new model

To gradually roll out a new model, start with a small weight and increase it as confidence grows:

```bash
# Day 1: 5% canary
MODEL_ROUTING=openai:0.95,vllm:0.05

# Day 3: 25% after reviewing quality metrics
MODEL_ROUTING=openai:0.75,vllm:0.25

# Day 7: full cut-over
MODEL_ROUTING=vllm:1
```

Each routing decision is logged as a structured `ab_routing` event:

```json
{
  "event": "ab_routing",
  "requestId": "...",
  "selectedBackend": "vllm",
  "weights": { "openai": 0.75, "vllm": 0.25 },
  "timestamp": "..."
}
```

### Fallback

Set `FALLBACK_BACKEND` to a backend name to use as a last resort when the primary backend returns 5xx or 429:

```bash
FALLBACK_BACKEND=openai
```

---

## Circuit Breaker

The circuit breaker protects SiskelBot from cascade failures when a backend becomes unhealthy. After N consecutive failures it opens and returns 503 immediately instead of waiting on the backend; after a cooldown period it allows one probe through to test recovery.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `CIRCUIT_BREAKER_FAILURES` | `5` | Consecutive failures before opening |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | `30000` | Milliseconds to wait before half-open |

### States

```
Closed ──(N failures)──► Open ──(cooldown elapsed)──► Half-open
   ▲                                                       │
   └──────────────── probe success ───────────────────────┘
                                  └── probe failure ──► Open (fresh cooldown)
```

- **Closed**: normal operation; failures accumulate but requests go through.
- **Open**: all requests fail fast with `503`; no calls reach the backend.
- **Half-open**: one probe request is allowed through; success closes the breaker, failure re-opens it with a fresh cooldown window.

### Tuning guidance

**Managed OpenAI** — fast recovery is appropriate because OpenAI's API is generally reliable and blips are short:

```bash
CIRCUIT_BREAKER_FAILURES=5
CIRCUIT_BREAKER_COOLDOWN_MS=30000
```

**Self-hosted Ollama** — be more conservative; a local GPU host that falls over may take longer to recover:

```bash
CIRCUIT_BREAKER_FAILURES=3
CIRCUIT_BREAKER_COOLDOWN_MS=60000
```

### Backend fetch tuning

Related settings that interact with the circuit breaker:

```bash
BACKEND_TIMEOUT_MS=60000       # Abort a backend call after this many ms (default 60s)
BACKEND_RETRY_MAX=2            # Retries for 5xx / connection errors (default 2)
BACKEND_RETRY_INITIAL_MS=1000  # Initial retry delay; doubles each attempt (default 1s)
BACKEND_FETCH_KEEPALIVE=1      # HTTP keep-alive to backend (default on; set to 0 to disable)
```

---

## Embedding Backends

SiskelBot uses embeddings for semantic search in the knowledge base and swarm intent classification. Embeddings can use a different backend than chat completions.

```bash
# Use a custom endpoint for embedding requests (e.g. a local embedding model)
OPENAI_EMBEDDINGS_BASE_URL=http://my-embedding-server/v1
```

Embeddings require `OPENAI_API_KEY` to be set and use the `text-embedding-3-small` model (1536 dimensions) by default. They are available whenever `OPENAI_API_KEY` is present, regardless of which `BACKEND` is active for chat. This means you can run chat via `BACKEND=ollama` while still getting full semantic search by setting an OpenAI key.

Embedding requests are subject to their own rate limit:

```bash
EMBEDDINGS_RATE_LIMIT_MAX=  # Requests per window for embedding endpoint
```

---

## Choosing a Backend for Production

| Scenario | Recommended | Why |
|---|---|---|
| SaaS / managed deployment | `openai` | No GPU infra, highest model quality, scales automatically |
| On-prem, dev or small team | `ollama` | Zero-cost, simple single-command setup, wide model support |
| On-prem, high throughput | `vllm` | Continuous GPU batching, production-grade throughput |
| Multi-model / experimentation | smart-router + `MODEL_ROUTING` | Automatic quality-based selection with canary support |
