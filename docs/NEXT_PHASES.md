# SiskelBot: Recommended Next Phases of Work

**Status date:** 2026-04-12
**Branch:** `claude/recommend-next-phases-eCoaH`

This document inventories what phases 51-70 actually shipped vs. what remains,
then proposes the next three waves of work: **closeout** (finish 51-70 gaps),
**verticalization** (phases 62-70), and **new Phases 71-80** (the horizon).

Each recommendation includes rationale, a leverage rating (⭐⭐⭐ highest), and
the concrete artifacts (`lib/`, `routes/`, `tests/`) that should land.

---

## Phase 51-70 closeout audit

Legend: ✅ shipped · 🟡 partial / needs hardening · ❌ not started

| Phase | Subtask | Artifact | Status |
|---|---|---|---|
| 51.1 | Jailbreak detection | `lib/jailbreak-detector.js` | ✅ |
| 51.2 | Output classifiers | `lib/output-classifiers.js` | ✅ |
| 51.3 | Constitutional AI | `lib/constitutional-ai.js` | ✅ |
| 51.4 | Policy audit trail | — | ❌ |
| 51.5 | Rate-limit tiers for risky ops | — | ❌ |
| 52.1 | Tree-of-Thought | `lib/tree-of-thought.js` | ✅ |
| 52.2 | Self-consistency | `lib/self-consistency.js` | ✅ |
| 52.3 | Graph-of-Thought | `lib/graph-of-thought.js` | ✅ |
| 52.4 | Neuro-symbolic (SAT/SMT) | — | ❌ |
| 52.5 | Verification loops | `lib/verification-loop.js` | ✅ |
| 53.1-5 | Tool Use 2.0 (all) | `lib/tool-*.js` (5) | ✅ |
| 54.1-5 | Multimodal 2.0 (all) | video/image/audio/3d/layout | ✅ |
| 55.1-5 | Computer-Use (all) | screen/browser/shell/fs/mobile | ✅ |
| 56.1 | Docker agent sandboxes | `lib/agent-sandbox.js` | 🟡 |
| 56.2 | Benchmark runner | `lib/benchmark-runner.js` | ✅ |
| 56.3 | Synthetic tasks | `lib/synthetic-tasks.js` | ✅ |
| 56.4 | Curriculum scheduler | `lib/curriculum.js` | ✅ |
| 56.5 | Reward-model training UI | `lib/preference-dataset.js` | 🟡 |
| 57.1-5 | Data Engineering (all) | — | ❌ |
| 58.1 | Cost-aware router | `lib/smart-router.js` | 🟡 |
| 58.2 | Speculative decoding | `lib/speculative-decoding.js` | ✅ |
| 58.3 | Prompt compression | — | ❌ |
| 58.4 | Model distillation | — | ❌ |
| 58.5 | Quantization management | `lib/quantization.js` | ✅ |
| 59.1 | Chaos engineering | `lib/chaos-engineering.js` | ✅ |
| 59.2 | Load shedding | — | ❌ |
| 59.3 | Degradation tiers | `lib/degradation-tiers.js` | ✅ |
| 59.4 | Canary + traffic shift | `lib/canary.js` | ✅ |
| 59.5 | Error-budget enforcement | `lib/error-budget.js` | ✅ |
| 60.1-5 | Observability Pro (all) | — | ❌ |
| 61.1 | API playground | `lib/api-playground.js`, client UI | ✅ |
| 61.2 | Webhook inspector | — | ❌ |
| 61.3 | Integration test harness | — | ❌ |
| 61.4 | Local dev environment | `lib/dev-setup.js`, CLI | ✅ |
| 61.5 | Schema registry | — | ❌ |
| 62-70 | Verticals + governance + UX | mostly — | ❌ |

**Closeout gap: ~40 subtasks remaining across Phases 51-70.**

---

## Wave 1 — Closeout (P0, ship before starting Phase 71)

Finish the in-flight roadmap before opening new fronts. These are small,
well-scoped, and each unblocks downstream work.

### C1. Phase 51.4 — Policy audit trail ⭐⭐⭐

**Why:** We ship jailbreak/toxicity/constitutional-AI classifiers but no durable
record of every allow/warn/block/revise decision. Without this, there's no way
to tune thresholds, debug false positives, or satisfy enterprise audit reqs.

**Deliverables:**
- `lib/policy-audit.js` — append-only log keyed by `(workspaceId, policyId, decisionId)`
- Wire into `jailbreak-detector.js`, `output-classifiers.js`, `constitutional-ai.js`
- `routes/policy-audit.js` — query + export endpoints (RBAC: admin + compliance roles)
- `tests/policy-audit.test.js`
- Admin UI panel under `/admin#safety`

### C2. Phase 51.5 — Rate-limit tiers for risky ops ⭐⭐

**Why:** Current quotas are per-endpoint. Risky tool calls (shell, browser,
filesystem writes, external fetches) should live on their own throttle lane so
a stressed user can't starve the safer majority.

**Deliverables:**
- Extend `lib/quotas.js` with `category` dimension (`safe`, `costly`, `risky`, `destructive`)
- Per-tool category tagging in `lib/agent-tools.js`
- Env: `QUOTA_TIER_RISKY_PER_MIN`, `QUOTA_TIER_DESTRUCTIVE_PER_HOUR`
- Headers: `X-Quota-Category`, `X-Quota-Tier-Remaining`

### C3. Phase 57 — Data Engineering (all 5) ⭐⭐⭐

Gate for future ML features (Phase 69 personalization, Phase 56.5 RM training).

- **57.1 DAG pipeline engine** — extend `lib/workflow-engine.js` with dependency
  DAG + retry/backoff + per-node time budgets (`lib/dag-pipeline.js`)
- **57.2 Data quality monitors** — `lib/data-quality.js`, drift detection on
  embedding distributions and conversation/eval streams
- **57.3 Schema evolution** — `lib/schema-registry.js` + versioned event schemas
  (reuses 61.5 work below)
- **57.4 Lineage tracking** — `lib/lineage.js`, OpenLineage-compatible event
  emission from knowledge ingestion and eval runs
- **57.5 Feature store** — `lib/feature-store.js` with online (Redis) + offline
  (JSON/SQLite) sync and TTLs

### C4. Phase 58.3 + 58.4 — Prompt compression + distillation ⭐⭐

**Why:** Both reduce unit cost without touching feature surface area.

- `lib/prompt-compression.js` — LLMLingua-style ranked-token dropping with
  per-model calibration; config via `PROMPT_COMPRESSION=1`
- `lib/distillation.js` — teacher-student pipeline wired to `eval-runner.js` so
  student quality is gated on golden traces before promotion

### C5. Phase 59.2 — Load shedding ⭐⭐

**Why:** Degradation tiers and error budget are in. Load shedding is the
missing piece that makes brown-outs actually work under surge.

- `lib/load-shedding.js` — priority queue (P0 health, P1 paid, P2 free, P3 batch)
- Integrated with `lib/request-timeout.js` and `lib/circuit-breaker.js`
- SSE `agent_shed` event when a run is evicted

### C6. Phase 60 — Observability Pro (all 5) ⭐⭐⭐

**Why:** We're now carrying 331 lib modules. Without deep runtime visibility,
regressions will start shipping invisibly.

- **60.1** `lib/profiling.js` — continuous pprof-style sampling, exposed on `/debug/pprof` (admin-gated)
- **60.2** `lib/heap-diff.js` — on-demand heap snapshot + diff (v8 inspector)
- **60.3** Per-cortex/per-tool latency rollup in `lib/tracing.js` → `/admin/observability`
- **60.4** `lib/log-analysis.js` — LLM-summarized anomaly digest from `log-shipper.js` stream
- **60.5** `lib/status-page.js` + `client/status.html` — public incident history from `lib/slo-tracker.js`

### C7. Phase 61.2, 61.3, 61.5 — Dev platform finish ⭐⭐

- **61.2 Webhook inspector** — `routes/webhook-inspector.js` + `client/webhook-inspector.html`; replay UI reuses `lib/webhook-delivery.js` DLQ
- **61.3 Integration test harness** — extend `lib/eval-runner.js` with recipe-level tests; `npm run test:recipes`
- **61.5 Schema registry** — `lib/schema-registry.js`, versioned OpenAPI + event schemas, PR-time diff check

---

## Wave 2 — Verticalization (Phases 62-64 + 67)

Once closeout lands, pick the vertical that aligns with near-term design
partners. All three are tractable on top of existing primitives.

### V1. Phase 63 — Code Generation (highest dev ROI) ⭐⭐⭐

Adjacent to existing agent + knowledge graph work; ships a monetizable pack.

- **63.1 Repo-level RAG** — tree-sitter indexer, AST-aware chunking (`lib/repo-rag.js`)
- **63.2 PR review agent** — inline-comment agent using GitHub MCP tools (`lib/pr-review-agent.js`)
- **63.3 Test generation** — coverage-gap driven via c8 lcov parsing (`lib/test-gen.js`)
- **63.4 Refactoring agent** — multi-file refactor with dry-run preview (`lib/refactor-agent.js`)
- **63.5 Migration assistant** — framework upgrade playbooks (`lib/migration-assistant.js`)

### V2. Phase 62 — Customer Support ⭐⭐

Clean application of existing intent + tool-routing + HITL primitives.

- `lib/intent-classifier.js`, `lib/ticket-router.js`, `lib/response-drafter.js`,
  `lib/escalation-rules.js`, `lib/csat-tracker.js`

### V3. Phase 64 — Research pack ⭐

`lib/literature-search.js` (arXiv + PubMed + S2), `lib/paper-summary.js`,
`lib/citation-graph.js`, `lib/experiment-bridge.js` (W&B/MLflow),
`lib/reproducibility-checks.js`.

### V4. Phase 67 — Content Moderation (pattern/classifier-based only) ⭐⭐

Safe-by-default moderation without storing harmful corpora in-tree.

- `lib/hash-detection-interface.js` — external provider stub interface only
- `lib/copyright-similarity.js` — cosine/Jaccard against user-provided corpus
- `lib/factuality-crossref.js` — claim-checker against configured sources
- `lib/brand-safety.js` — configurable brand-guardrail rules engine
- `lib/hitl-moderation.js` — reviewer queue + assignment workflow

---

## Wave 3 — Proposed Phases 71-80

New strategic work once 51-70 + at least one vertical is complete.

### Phase 71 — Agent Economics

Pay-per-outcome agents; pricing primitives the verticals will need.

| # | Subtask |
|---|---------|
| 71.1 | Usage-based pricing engine (per-token, per-call, per-outcome) |
| 71.2 | Outcome verification (did the agent accomplish the goal?) |
| 71.3 | Revenue-share for plugin/recipe authors |
| 71.4 | Credit system + prepaid balances |
| 71.5 | Invoice + receipt generation |

### Phase 72 — Trust & Safety Pro

Builds on 51 + 67; graduates SiskelBot to enterprise-grade T&S.

| # | Subtask |
|---|---------|
| 72.1 | Red-team harness (using classifier-generated probes only — no harmful corpora) |
| 72.2 | Model-card generator (per deployed model, auto-updated) |
| 72.3 | Bias evaluation suite on synthetic personas |
| 72.4 | Privacy-preserving telemetry (k-anonymous event aggregation) |
| 72.5 | Safety SLA dashboard (per-classifier precision/recall over time) |

### Phase 73 — Agent Reliability

Unknown-unknowns hunting for agent runs.

| # | Subtask |
|---|---------|
| 73.1 | Agent fuzzing (perturb inputs, detect crashes / infinite loops) |
| 73.2 | Run replay determinism harness |
| 73.3 | Stagnation-pattern library + auto-intervention |
| 73.4 | Trajectory-clustering anomaly detection |
| 73.5 | Post-mortem generator from trajectory + logs |

### Phase 74 — Memory 2.0

Upgrade `lib/agent-memory.js` + `gbrain-memory*` to first-class memory tier.

| # | Subtask |
|---|---------|
| 74.1 | Episodic memory with recency/importance decay |
| 74.2 | Semantic memory consolidation (episodic → facts) |
| 74.3 | Procedural memory (learned recipes from successful runs) |
| 74.4 | Memory conflict resolution + provenance |
| 74.5 | User-facing memory editor UI |

### Phase 75 — Evaluation 2.0

Complete the eval stack: static → live → prod regression.

| # | Subtask |
|---|---------|
| 75.1 | Eval-in-prod (shadow traffic against candidate model/policy) |
| 75.2 | LLM-as-judge calibration harness |
| 75.3 | Pairwise preference collection UI |
| 75.4 | Regression bisection (which commit broke the trace) |
| 75.5 | Synthetic user simulation for multi-turn eval |

### Phase 76 — Edge & Offline

Extends `offline-models.js` + `edge-ai-router.js` toward true offline-first.

| # | Subtask |
|---|---------|
| 76.1 | Client-side inference (WebLLM / ONNX Web) |
| 76.2 | Conflict-free offline writes (CRDT-backed conversation store) |
| 76.3 | Background sync for offline queue |
| 76.4 | Delta-only model updates |
| 76.5 | Offline eval runs with later sync |

### Phase 77 — Integrations Breadth

Double integration catalogue without re-implementing pipes per vendor.

| # | Subtask |
|---|---------|
| 77.1 | Universal OAuth broker (1 flow, N providers) |
| 77.2 | Integration manifest DSL (YAML → routes + UI) |
| 77.3 | Salesforce, HubSpot, Zendesk connectors |
| 77.4 | Notion, Confluence, Google Docs ingestion |
| 77.5 | Airtable, Google Sheets bidirectional sync |

### Phase 78 — Governance UX

Surface existing governance primitives to non-technical admins.

| # | Subtask |
|---|---------|
| 78.1 | Visual policy builder (no-code constitutional rules) |
| 78.2 | Compliance dashboard with control-map to SOC 2 / ISO 27001 |
| 78.3 | Privileged access management (PAM) workflow for admin ops |
| 78.4 | Retention & legal-hold UI |
| 78.5 | Data subject request (DSR) self-service portal |

### Phase 79 — SiskelBot as Platform

Make SiskelBot embeddable in third-party products.

| # | Subtask |
|---|---------|
| 79.1 | Embeddable chat widget (iframe + postMessage API) |
| 79.2 | White-label theming API beyond current `white-label.js` |
| 79.3 | Customer-owned data plane (BYOK, BYOC storage) |
| 79.4 | Per-embed analytics |
| 79.5 | Partner billing handoff (Stripe Connect) |

### Phase 80 — Model Lifecycle

Unify `model-registry.js`, `model-quality.js`, `ab-router.js`, canary into a
single model-lifecycle product surface.

| # | Subtask |
|---|---------|
| 80.1 | Model registry 2.0 (versions, lineage, approval status) |
| 80.2 | Golden-trace + eval gate on every promotion |
| 80.3 | Shadow deployment with diff reporting |
| 80.4 | Auto-rollback on SLO breach (wires 59.5 + 80.2) |
| 80.5 | Deprecation scheduler for retiring models |

---

## Prioritization summary

| Rank | Work | Rationale |
|---|---|---|
| **P0** | Wave 1 closeout (especially C1, C3, C6) | Every future phase depends on observability, data infra, and safety audit |
| **P1** | V1 (Phase 63 code-gen vertical) | Highest monetization leverage; reuses the most existing infra |
| **P2** | Phase 75 (Eval 2.0) + Phase 72 (Trust & Safety Pro) | Needed to ship verticals confidently to design partners |
| **P3** | Remaining verticals (62, 64, 67), Phase 71, 74, 80 | Breadth once depth is locked |
| **P4** | Phases 76-79 | Strategic but deferrable |

## Execution guidance

- Keep the existing 5-subtasks-per-phase shape — it parallelizes cleanly.
- Maintain the convention: each subtask ships `lib/*.js` + `routes/*.js` (where
  user-facing) + `tests/*.test.js` and registers via `mountAllRoutes`.
- Run `npm run eval:ci` on every PR that touches `lib/agent-*` or `lib/gbrain*`.
- Before Phase 71 opens, the Wave 1 closeout should be green on main and the
  c8 coverage floor should stay at current levels (lines 50, funcs 45, branch 40).
- Reassess Phase 80 scope after Phase 75 ships — they overlap on eval gates.
