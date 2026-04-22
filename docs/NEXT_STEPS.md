# SiskelBot — Recommended Next Steps

**Status date:** 2026-04-21
**Branch:** `claude/recommend-next-steps-yWvy7`
**Supersedes:** the 2026-04-14 revision of this file (Phase 63/64/71/72/75
fronts closed).

One week after the last revision, everything it called out under P1–P4 has
shipped. The hygiene items from its P0, however, did not — and one got
worse. This revision refocuses the next wave on consolidation and
design-partner burn-in rather than opening new phases.

---

## Where we are

**Repo shape**

| Metric | 2026-04-14 | 2026-04-21 | Δ |
|--------|------------|------------|---|
| `server.js` lines | 1,257 | 1,453 | +196 |
| `routes/index.js` lines | — | 554 | — |
| `lib/` modules | 371 | 439 | +68 |
| `routes/` modules | 195 | 239 | +44 |
| `tests/` files | 318 | 459 | +141 |
| Coverage floor (lines/funcs/branches) | 50/45/40 | 50/45/40 | — |

**What shipped since the prior revision**

All 25 planned modules from the last doc landed with tests:

| Phase | Modules |
|-------|---------|
| 63 Code Generation | `repo-rag`, `pr-review-agent`, `test-gen`, `refactor-agent`, `migration-assistant` |
| 64 Research | `literature-search`, `paper-summary`, `citation-graph`, `experiment-bridge`, `reproducibility-checks` |
| 71 Agent Economics | `pricing-engine`, `outcome-verification`, `revenue-share`, `credit-system`, `invoicing` |
| 72 Trust & Safety Pro | `red-team-harness`, `model-card-generator`, `bias-eval-suite`, `k-anonymous-telemetry`, `safety-sla` |
| 75 Evaluation 2.0 | `eval-in-prod`, `judge-calibration`, `preference-dataset`, `regression-bisection`, `synthetic-users` |

Notable side-lands: unified quality dashboard, shareable anonymized trace
URLs, DAG-based swarm orchestration, dynamic MCP tool discovery, trajectory
branching, per-profile success models, subagent memoization, feedback →
prompt-tuner loop with CI regression gate.

**What did NOT ship from the prior P0**

1. `server.js` drift — got worse (+196 lines).
2. Coverage floor uplift to 55/50/45 — floor is still 50/45/40.
3. Wire-check audit — 44 new route modules were added without a reconciled
   sweep of `mountAllRoutes` vs `routes/*.js` exports.

---

## Recommended next steps (prioritized)

Appetite has clearly been on breadth. Depth is now the bottleneck. Resist
opening Phase 73/74/76–80 until the consolidation wave lands.

### P0 — Consolidation (ship before anything new)

1. **`server.js` extract.** Carve `server.js` down to a composition root
   (<600 lines). Targets: middleware stack, startup checks, WebSocket
   upgrade wiring, graceful-shutdown hooks → each to a focused module in
   `lib/`. One PR per extraction to keep review cheap.

2. **Wire-check audit.** For every `lib/<feature>.js` with a matching
   `routes/<feature>.js`, assert the route is mounted and has at least one
   test that hits it via `supertest`. Encode this as a script under
   `scripts/wire-check.mjs` run in CI. Gap-list first, fixes second.

3. **Coverage floor to 55/50/45.** Prior doc called for this; it never
   happened. The 141 new test files likely bought room — run
   `npm run test:coverage`, bump `.c8rc.json`, fix the shortfall. Critical
   paths in `_criticalPathThresholds.files` should also widen (add
   `lib/agent-session.js`, `lib/eval-in-prod.js`, `lib/pr-review-agent.js`,
   `lib/repo-rag.js`).

4. **Dead-route / dead-module sweep.** With 239 route modules and 439 lib
   modules, some shipped-and-forgotten surface exists. Grep for
   zero-importers in `lib/`, zero-reference routes in the client, and
   either wire them up or delete. Do not keep half-finished scaffolds.

### P1 — Design-partner burn-in ⭐⭐⭐

The Phase 63 code-gen vertical is the highest-value product surface the
repo now has. It will not hold up under a design partner until:

- **P1.1 End-to-end golden path.** A single scripted flow `workspace → repo
  ingest → repo-rag query → PR review → test-gen → merge` with
  Playwright coverage and a cost budget captured in the trace. Put the
  script in `tests/e2e/` and run it in `test:e2e:api`.
- **P1.2 `pr-review-agent` HITL defaults.** Any comment-posting action must
  default to draft mode; require explicit approval via
  `lib/agent-hitl-store.js`. Today's default is almost certainly too hot
  for a design partner.
- **P1.3 Cost attribution per Phase 63 call.** Wire `lib/pricing-engine.js`
  + `lib/usage-tracker.js` so every `repo-rag`/`pr-review`/`test-gen` run
  lands on an invoice line. Without this, the economics modules shipped
  but don't meter the product.
- **P1.4 Failure-mode docs.** `docs/PR_REVIEW_AGENT.md`,
  `docs/REPO_RAG.md`, `docs/TEST_GEN.md` each with: inputs, limits, known
  failure modes, HITL guarantees, how to disable. None of these docs
  exist today.
- **P1.5 Eval-in-prod wired to Phase 63.** `lib/eval-in-prod.js` shipped
  generically. Register `pr-review-agent` and `test-gen` as tracked
  subjects so regression bisection can find breaks automatically.

### P2 — Operational hardening ⭐⭐

These are load-bearing modules that landed without being exercised under
load:

- **P2.1 Chaos drill.** `lib/chaos-engineering.js` exists; add a
  scheduled run (weekly, staging-only) that kills one backend, trips the
  circuit breaker, and asserts the status page reflects reality within
  60s. Hooks: `lib/region-health.js`, `lib/status-page.js`.
- **P2.2 Safety SLA backtest.** `lib/safety-sla.js` tracks precision/recall
  over time — seed with a 90-day backfill from existing traces so the
  dashboard is useful on day one.
- **P2.3 Load-shed tuning.** `lib/load-shedding.js` is in place; run
  `npm run test:load` against it, publish thresholds in `docs/RUNBOOK.md`.
- **P2.4 Leader-election under partition.** `lib/leader-election.js` has
  not been exercised under a network partition. Add a fault-injection
  test (toggle Redis availability mid-flight) and document the failure
  mode.

### P3 — Open a new front only after P0+P1 land

If (and only if) P0 and P1 are green, pick ONE:

- **Phase 73 Compliance Automation** — `lib/compliance.js` exists but is
  thin; SOC2/ISO audit evidence collection + export pipeline.
- **Phase 76 Privacy Engineering** — differential-privacy telemetry, PII
  redaction preflight, right-to-erasure workflow.
- **Phase 80 Model Lifecycle** — `lib/model-registry.js` exists; build
  out champion/challenger routing, automated rollback on quality
  regression.

Do not open two at once. The last wave's breadth is the reason we need
this consolidation wave.

---

## Explicitly out of scope for this wave

- New agent tools. The current 21-tool surface is already hard to eval.
- New integration surfaces (Teams, Notion, etc.). Slack/Discord/Jira/
  Linear are sufficient until a partner asks.
- Additional storage backends. JSON/SQLite/Postgres is enough.

---

## Execution guidance

- One PR per P0 subtask. Keep review small. Merge before moving on.
- Every P1 subtask ships code + test + doc. Missing doc = not done.
- P0.3 (coverage floor) is a gate on all P1 work — do not raise the floor
  and open a new front in the same PR.
- Run `npm run eval:ci` on any PR touching `lib/agent-*`, `lib/repo-rag.js`,
  `lib/pr-review-agent.js`, `lib/test-gen.js`, or `lib/eval-*`.
- Prefer shrinking `server.js` and `routes/index.js` over growing them.
