# Benchmark: running the mini suite against real models

`scripts/run-benchmark-real.js` wires the benchmark harness (`lib/benchmark-harness.js`) to a live LLM backend via `lib/benchmark-real-agent.js`. Use it to produce actual pass-rate numbers for a given model/backend and (optionally) record them to the eval-history store for longitudinal comparison.

This is a **data-collection tool, not a CI gate.** A low pass-rate is not an error — exit code 2 is reserved for script failures only (bad argv, suite load failure, harness throwing).

## Security

Generated code is executed in an **isolated Node subprocess** (env={}, cwd=tmpdir, kill on timeout) by `lib/benchmark-scorer.js`. The adapter in this doc only adds a network call layer — no new sandbox surface is introduced. API keys are read from env vars and are **never logged** to stdout/stderr by the adapter (enforced by a unit test).

## Supported backends

| Backend           | Endpoint                       | Auth header                                    | Request shape                     |
|-------------------|--------------------------------|------------------------------------------------|-----------------------------------|
| `openai`          | `POST /v1/chat/completions`    | `Authorization: Bearer $OPENAI_API_KEY`        | OpenAI chat (messages[])          |
| `vllm`            | `POST /v1/chat/completions`    | `Authorization: Bearer $VLLM_API_KEY` (opt.)   | OpenAI-compatible                 |
| `siskelbot-proxy` | `POST /v1/chat/completions`    | `Authorization: Bearer $API_KEY`               | OpenAI-compatible                 |
| `anthropic`       | `POST /v1/messages`            | `x-api-key: $ANTHROPIC_API_KEY` + `anthropic-version: 2023-06-01` | Messages API (top-level `system`) |
| `ollama`          | `POST /api/chat`               | _(none)_                                       | Ollama chat                       |

## Environment variables

| Var                  | Read when backend is           |
|----------------------|--------------------------------|
| `OPENAI_API_KEY`     | `openai`                       |
| `ANTHROPIC_API_KEY`  | `anthropic`                    |
| `API_KEY`            | `siskelbot-proxy`              |
| `VLLM_API_KEY`       | `vllm` (optional)              |

You can also pass a key explicitly via `config.apiKey` when using the library directly. The CLI always reads from env.

## CLI flags

```
node scripts/run-benchmark-real.js \
    --backend <openai|anthropic|ollama|vllm|siskelbot-proxy> \
    --model <model-name> \
    [--suite mini] \
    [--workspace default] \
    [--baseUrl URL] \
    [--concurrency N]       # 1..4, default 1
    [--output report.json] \
    [--record] \
    [--baseline-from <sample-id|latest>]
```

`--concurrency` is capped at **4** because every request hits the provider. Higher values will trip rate limits on OpenAI/Anthropic. Start at 1 and raise only if you control the endpoint.

## Example commands

OpenAI (GPT-4o mini, record baseline, write JSON report):
```bash
export OPENAI_API_KEY=sk-...
node scripts/run-benchmark-real.js \
    --backend openai --model gpt-4o-mini \
    --record --output reports/gpt-4o-mini.json
```

Anthropic (Claude Sonnet 4.5):
```bash
export ANTHROPIC_API_KEY=sk-ant-...
node scripts/run-benchmark-real.js \
    --backend anthropic --model claude-sonnet-4-5 --record
```

Anthropic (Claude Sonnet 4.6 — released 2026):
```bash
node scripts/run-benchmark-real.js \
    --backend anthropic --model claude-sonnet-4-6 --record
```

Local Ollama:
```bash
node scripts/run-benchmark-real.js \
    --backend ollama --model llama3:8b --baseUrl http://localhost:11434
```

SiskelBot proxy (whatever the proxy backs):
```bash
export API_KEY=your-proxy-key
node scripts/run-benchmark-real.js \
    --backend siskelbot-proxy --model gpt-4o \
    --baseUrl http://localhost:3000 --record
```

vLLM self-hosted:
```bash
node scripts/run-benchmark-real.js \
    --backend vllm --model meta-llama/Llama-3-8B \
    --baseUrl http://vllm.internal:8000 --concurrency 4
```

## Recording baselines + comparing

Adding `--record` writes a sample to the eval-history store:

```
kind: "benchmark"
suite: "mini"
metrics: { passRate, total, passed, avgDurationMs }
tags: { backend, model }
```

The sample id is printed on success. To compare a future run to it:

```bash
node scripts/run-benchmark-real.js \
    --backend anthropic --model claude-sonnet-4-6 \
    --baseline-from 0f3e...-uuid-from-previous-run
```

The CLI will print a `passRate A → B (+X.Ypp)` delta in human form. Use `--baseline-from latest` to auto-pick the most recent matching sample for the same `backend`/`model`/`suite` tuple.

## Rough cost per suite run (back-of-envelope)

The mini suite is 10 tasks, ~1–2 KB prompt each, ~300–600 output tokens each. So roughly:

| Model                   | Input tok | Output tok | Cost (USD) |
|-------------------------|-----------|------------|------------|
| `gpt-4o-mini`           | ~8k total | ~5k total  | < $0.01    |
| `gpt-4o`                | ~8k       | ~5k        | ~$0.10     |
| `claude-sonnet-4-5`     | ~8k       | ~5k        | ~$0.10     |
| `claude-opus-4-*`       | ~8k       | ~5k        | ~$0.50     |
| `llama3:8b` via Ollama  | —         | —          | $0 (local) |

Treat these as order-of-magnitude guidance. Pricing changes; cross-check the provider's live pricing page before a budgeted run.

## Rate-limit notes

- **OpenAI**: default tier usually tolerates `--concurrency 4` for the mini suite. If you hit 429s, drop to 1 and retry.
- **Anthropic**: default tier recommends `--concurrency 1–2`. The suite finishes in under 90 seconds at concurrency=1 for most Claude models.
- **Ollama / vLLM**: bottleneck is GPU VRAM, not API quota. `--concurrency 4` is fine on reasonable hardware.

## Troubleshooting

| Symptom                                          | Likely cause                                              |
|--------------------------------------------------|-----------------------------------------------------------|
| Every task fails with `no code block`            | Model wrapped output in prose; try a stricter model.      |
| `HTTP 401`                                       | Missing/invalid env var. Key is NOT logged on purpose.    |
| `request timed out after 60000ms`               | Model stalled. Bump `config.timeoutMs` when using the library directly; or retry. |
| `unexpected anthropic response shape`            | Provider returned a tool-use or refusal-only block. The adapter expects at least one `{type:"text"}` block. |
| Pass-rate 0% with Ollama                          | Small local models often can't produce a clean fenced block. Try `llama3.1:8b` or larger, or try reducing temperature.  |

## Extraction false-positives

`extractCode()` prefers ```javascript/```js fences. If a model replies with a fence containing prose _and_ a bare code block, the largest fence wins. If no fence is present, the full response is used _only if_ it contains at least one of `export`, `function`, `const`, `let`, `var`, `return`, or `=>`. This avoids scoring refusal messages ("I cannot help…") as code but also means a fenceless but syntactically-valid module will still be accepted — operators should prefer models that reliably produce fenced blocks.
