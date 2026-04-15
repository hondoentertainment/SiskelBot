# SiskelBot — Recommended Next Steps

**Status date:** 2026-04-14
**Branch:** `claude/recommend-next-steps-jNaEP`
**Superseded by:** [`docs/NEXT_STEPS_WAVE_2.md`](NEXT_STEPS_WAVE_2.md) — P1–P3 items below have shipped
**Supersedes:** [`docs/NEXT_PHASES.md`](NEXT_PHASES.md) (Wave 1 closeout has largely shipped)

This document takes fresh stock of the tree after the Phase 51–70 closeout
landed and recommends the next concrete wave of work.

---

## Where we are

**Repo shape**
- `server.js`: 1,257 lines (composition root)
- `routes/`: 195 modules (37 core + v2 + 150+ Phase 51–70 modules)
- `lib/`: 371 modules
- `tests/`: 318 files
- Coverage floor: lines 50 / funcs 45 / branches 40 (per `.c8rc.json`)

**What shipped since `docs/NEXT_PHASES.md` was written**

Wave 1 closeout is substantially complete. Every module called out in that
doc is present in `lib/` or `routes/`:

| Phase | Module |
|-------|--------|
| 51.4  | `policy-audit.js` |
| 51.5  | `risky-ops-quota.js` |
| 52.4  | `neuro-symbolic.js` |
| 57.1–5 | `dag-pipeline.js`, `data-quality.js`, `schema-evolution.js`, `lineage.js`, `feature-store.js` |
| 58.1/3/4 | `cost-aware-router.js`, `prompt-compression.js`, `distillation.js` |
| 59.2  | `load-shedding.js` |
| 60.1–5 | `profiling.js`, `heap-diff.js`, per-tool latency in `tracing.js`, `log-analysis.js`, `status-page.js` |
| 61.2/5 | `webhook-inspector.js`, `schema-registry.js` |
| 62    | `intent-classifier.js`, `ticket-router.js`, `response-drafter.js`, `escalation-rules.js`, `csat-tracker.js` |
| 67    | `hash-detection.js`, `copyright-similarity.js`, `factuality-crossref.js`, `brand-safety.js`, `hitl-moderation.js` |
| 65/68 | approvals, usage-policies, budget-alloc, audit-reports, risk-scoring, web-ingestion, large-retrieval, fact-verification, source-credibility, freshness-sla |

**What's still outstanding from that doc**
- **V1 — Phase 63 Code Generation:** `repo-rag.js`, `pr-review-agent.js`, `test-gen.js`, `refactor-agent.js`, `migration-assistant.js` — none shipped
- **V3 — Phase 64 Research pack:** `literature-search.js`, `paper-summary.js`, `citation-graph.js`, `experiment-bridge.js`, `reproducibility-checks.js` — none shipped
- **Wave 3 Phases 71–80:** only `model-registry.js` and `white-label.js` exist; the rest are greenfield

---

## Recommended next steps (prioritized)

### P0 — Close out the last closeout items (1 PR each)

These are small and they finish Wave 1 for real.

1. **Coverage uplift pass.** Closeout shipped ~40 modules but the coverage
   floor hasn't moved. Run `npm run test:coverage`, identify the 10 lowest-
   covered closeout modules, and backfill tests to push the floor to
   lines 55 / funcs 50 / branches 45 before opening new fronts.

2. **Wire-check audit.** With 195 route modules and 378 `mount*Routes`
   references in `routes/index.js`, verify nothing shipped with lib + tests
   but no HTTP surface. Grep `mountAllRoutes` vs `routes/*.js` exports and
   close any gaps.

3. **`server.js` drift.** It grew from 1,073 → 1,257 lines. Extract the
   drift (likely middleware + new startup checks) into focused modules so
   `server.js` stays a composition root.

### P1 — Phase 63 Code Generation vertical ⭐⭐⭐

Highest monetization leverage and reuses the most existing infra (agent
loop, knowledge graph, search index, MCP client, GitHub MCP tools).

- **63.1 Repo-level RAG** — `lib/repo-rag.js`
  - Tree-sitter based AST-aware chunking (one parser per language, start
    with JS/TS/Python/Go)
  - Reuse `lib/search-index.js` inverted index + `lib/knowledge-graph.js`
    for cross-file entity linking
  - New agent tool `search_repo` gated behind `WORKSPACE_FILE_TOOLS=1`
- **63.2 PR review agent** — `lib/pr-review-agent.js`
  - Uses GitHub MCP tools (`mcp__github__*`) already available
  - Posts inline comments via `add_comment_to_pending_review`
  - Policy gate via existing `lib/policy-audit.js`
- **63.3 Test generation** — `lib/test-gen.js`
  - Parse c8 lcov output to find uncovered lines
  - Agent generates test + runs it + verifies coverage bump
- **63.4 Refactoring agent** — `lib/refactor-agent.js`
  - Multi-file edits with dry-run preview (diff-only mode)
  - HITL approval via existing `lib/agent-hitl-store.js`
- **63.5 Migration assistant** — `lib/migration-assistant.js`
  - Framework-version upgrade playbooks (Express 4 → 5, Node 18 → 22, etc.)
  - Reuses `lib/recipes.js` for playbook storage

Each subtask ships `lib/*.js` + `routes/*.js` + `tests/*.test.js` and
registers in `mountAllRoutes`.

### P2 — Phase 75 Evaluation 2.0 ⭐⭐⭐

Needed before shipping Phase 63 to design partners and before Phase 80
model-lifecycle work. Existing `eval-*.js` modules (7 of them) give us a
big head start.

- **75.1 Eval-in-prod** — shadow traffic: mirror `/v1/chat/completions` to
  a candidate model, diff against production, never surface to user
- **75.2 LLM-as-judge calibration** — harness that measures judge
  precision/recall against human-labeled goldens
- **75.3 Pairwise preference UI** — client page + route to collect A/B
  preferences; feeds `lib/preference-dataset.js`
- **75.4 Regression bisection** — given a failing trace, `git bisect`
  across recent commits to find the breaker
- **75.5 Synthetic user simulation** — multi-turn eval agent that plays
  the user role, scored by goal completion

### P3 — Phase 72 Trust & Safety Pro ⭐⭐

Builds on Phase 51 (safety) + Phase 67 (moderation). Gates enterprise
design partner deals.

- **72.1 Red-team harness** (classifier-generated probes only)
- **72.2 Model card generator** (auto-updated per deployed model)
- **72.3 Bias eval suite** on synthetic personas
- **72.4 k-anonymous telemetry**
- **72.5 Safety SLA dashboard** (precision/recall over time per classifier)

### P4 — Pick one: Phase 64 Research pack OR Phase 71 Agent Economics

Choose based on design-partner signal.

- **Phase 64 (Research)** if research/ML-user signal: 5 modules as listed
  in `NEXT_PHASES.md`
- **Phase 71 (Agent Economics)** if monetization pressure: pricing engine,
  outcome verification, revenue share, credit system, invoicing

Don't open both in parallel.

---

## Out of scope for this wave

- Phases 73–74, 76–80 from `NEXT_PHASES.md` remain deferred until Phase
  63 + Phase 75 ship and at least one design partner is live.
- `AGENT_NEXT_STEPS.md` is historical (pre-refactor) — retain for context
  but do not plan against it.

---

## Execution guidance

- Keep the 5-subtask-per-phase shape.
- Every subtask: `lib/*.js` + `routes/*.js` + `tests/*.test.js` + wire in
  `routes/index.js::mountAllRoutes`.
- Do not ship without tests — coverage floor is the contract.
- Run `npm run eval:ci` on every PR that touches `lib/agent-*`,
  `lib/gbrain*`, `lib/eval-*`, or `lib/repo-rag.js`.
- Use parallel worktrees (one per subtask) as with Phase 51–70; the
  `AGENT_*_WIRING.md` pattern worked well and should continue.
