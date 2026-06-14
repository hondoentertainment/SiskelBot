# A/B Testing

## Overview

SiskelBot uses `lib/ab-router.js` to deterministically route requests to model
or feature variants. The router takes a config string like
`MODEL_ROUTING=ollama:0.8,openai:0.2` and hashes each request's `requestId` to
pick a variant — the same caller deterministically lands on the same variant,
which is essential for honest experimentation.

This page documents how to design an experiment, collect outcome data, and
turn raw per-variant traffic into a statistical decision using
`scripts/ab-analyze.mjs`.

## Setup an experiment

The router config lives in the `MODEL_ROUTING` env var. Format:

```bash
MODEL_ROUTING=variantA:50,variantB:50
```

Weights are normalized; you can also write `variantA:0.5,variantB:0.5`. Add
more variants by adding more `name:weight` pairs. Backends with an open
circuit breaker are filtered out automatically (see `lib/circuit-breaker.js`).

For multi-variant experiments outside of model routing (e.g. swarm-v1 vs
swarm-v2, or a new prompt template), follow the same pattern: hash the
request ID, bucket by weight, log the assignment, and record the outcome
with the variant tag.

## Collect data

Variants are logged via `logRouting()` in `lib/ab-router.js` and per-variant
metrics flow through `lib/metrics.js` (Prometheus). For statistical analysis
you need the *raw* per-request observations — typically latency samples and
error counts per variant.

Export those into a JSON file with this shape:

```json
{
  "experiment": "swarm-v2",
  "variants": {
    "control":   { "latencies": [120, 135, 118, 142, ...], "errors": 7 },
    "treatment": { "latencies": [105, 110, 102, 115, ...], "errors": 3 }
  }
}
```

`latencies` is an array of per-request observations (in whatever metric you
care about — usually ms). `errors` is the absolute count of failed requests
for that variant. Sample sizes do not need to match across variants.

## Run analysis

```bash
node scripts/ab-analyze.mjs \
  --experiment=swarm-v2 \
  --metric=p95_latency_ms \
  --input=experiment-results.json \
  --output=docs/EXPERIMENTS/swarm-v2-2026-04-28.md
```

The tool emits a markdown report containing:

- **Per-variant summary**: count, mean, p50/p95/p99, error rate
- **Lift %** of the second variant relative to the first
- **p-value** from Welch's t-test (with normal approximation for df > 30)
- **95% confidence interval** on the treatment mean
- **Recommendation**: deploy / revert / inconclusive

Exit code is `1` when there is a statistically significant regression
(p < 0.05 and `meanB < meanA`), `2` for usage errors, `0` otherwise — so the
script can be used as a CI gate.

## Decision criteria

| p-value | Sample size | Action                                      |
|---------|-------------|---------------------------------------------|
| < 0.01  | > 1000      | Strong signal — ship the winner / revert the loser |
| < 0.05  | > 100       | Moderate signal — ship if observed lift > 5% |
| ≥ 0.05  | any         | Inconclusive — extend the run or stop the experiment |

These thresholds are heuristics, not hard rules. A statistically significant
0.5% lift on a non-critical metric may not justify the migration cost.

## Common pitfalls

- **Peeking** — checking p-values continuously and stopping as soon as you
  see < 0.05 inflates the false-positive rate. Decide on a sample size up
  front, or use a sequential testing method.
- **Multiple comparisons** — running N tests and declaring any one
  significant means you'll declare ~5% × N false positives. Apply a
  Bonferroni correction (divide your alpha by N) when comparing several
  metrics or several variants at once.
- **Simpson's paradox** — an aggregate lift can flip sign once you segment
  by user cohort, geography, or time of day. Always sanity-check the
  headline number against sub-segments before shipping.
- **Novelty effects** — a new variant often looks better simply because it
  is new (or worse, because users haven't adapted). Run experiments long
  enough to clear the novelty window — typically at least one full weekly
  cycle for user-facing changes.
- **Variance from outliers** — Welch's t-test assumes roughly normal
  residuals. Latency distributions are usually right-skewed; consider
  reporting medians and p95s alongside the mean, and trim or
  log-transform extreme outliers before fitting.
