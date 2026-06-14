# Chaos Testing

The chaos test suite verifies that SiskelBot's resilience patterns
(circuit breakers, stagnation detection, partial-failure tolerance,
health probes) actually fire when failures are injected. These tests
are intentionally separate from the regular unit-test pass.

## What chaos tests verify

Chaos tests assert resilience pattern behavior, **not** functional
correctness. A chaos test is "passing" when the system degrades
gracefully — fails fast, isolates the fault, records observability,
and recovers when the fault is removed.

What chaos tests are *not*:

- They are not load tests (see `npm run test:load`).
- They are not eval-set regressions (see `npm run eval:ci`).
- They are not contract tests against real backends — every external
  dependency is mocked or stubbed.

## How to run

Locally:

```bash
npm run test:chaos
```

The default `npm test` invocation does not include chaos tests
(`scripts/run-tests.mjs` skips `tests/chaos/`). Chaos tests run on a
weekly schedule in CI via `.github/workflows/chaos.yml` (Sundays at
04:00 UTC) and can be triggered manually with `workflow_dispatch`.

## When to add a new scenario

Add a chaos scenario whenever a real production incident exposes a
failure mode the suite does not yet codify. The workflow is:

1. Reproduce the failure mode in isolation (mock the failing
   dependency).
2. Add a new `tests/chaos/<scenario>.test.js` that injects the fault
   and asserts the resilience pattern that *should* have caught it
   (or, after a fix, *did* catch it).
3. Tag the test header with `// CHAOS TEST: <name>` and
   `// EXPECTED: <pattern>`.
4. Keep each test under a 10-second timeout — if a chaos test hangs,
   the resilience pattern is broken.

## Current scenarios

| File | Scenario |
|---|---|
| `tests/chaos/backend-timeout.test.js` | Backend (OpenAI/Ollama/vLLM) hangs forever — circuit breaker opens, half-opens after cooldown, closes on a successful probe. |
| `tests/chaos/db-partition.test.js` | Storage layer throws ECONNREFUSED — `/health/ready` 503s within 3s, `/health/live` still 200, `/health/deep` reports `storage:down` and overall `down`. |
| `tests/chaos/swarm-partial-failure.test.js` | 2 of 3 swarm specialists throw — orchestrator returns degraded but non-empty result, `swarmConflictCounts` increments, errors are logged but the request does not crash. |
| `tests/chaos/agent-loop-runaway.test.js` | Tool always returns "no progress" — stagnation detector trips within `AGENT_STAGNATION_WINDOW`, the loop terminates with `stop_reason="stagnation"`, and the reason is recorded in metrics. |

## Future scenarios (TODO)

- [ ] DNS resolution failure (every outbound `fetch` rejects with
      `EAI_AGAIN`) — verify retry backoff and circuit breaker behave
      correctly.
- [ ] Partial network partition (one of two storage replicas reaches
      the leader, the other does not) — verify leader election and
      DLQ semantics.
- [ ] Leader election split-brain (two replicas both believe they are
      leader for ~5 seconds) — verify scheduled jobs do not double-run
      and the loser yields cleanly.
- [ ] Slow loris stream (chunked SSE response that emits one byte per
      second) — verify SSE timeout is enforced and connection is
      reaped.
- [ ] Webhook receiver returns 5xx for every attempt — verify DLQ
      receives the payload after retries are exhausted.
- [ ] Embedding provider quota exhausted (every call returns 429) —
      verify graceful fallback to keyword search.
