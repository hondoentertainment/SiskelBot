# SiskelBot — Recommended Next Steps (consolidation & depth)

**Status date:** 2026-05-15

**Canonical agent-focused list:** [docs/AGENT_NEXT_STEPS.md](./AGENT_NEXT_STEPS.md); **programs:** [docs/AGENT_WORLD_CLASS_ROADMAP.md](./AGENT_WORLD_CLASS_ROADMAP.md)

Depth and consolidation are now the bottleneck relative to breadth. Prefer tightening boots-on-the-ground quality (routes, tests, CI gates, partner-ready flows) over opening new themed “phases” until P0 is steady. For the numbered agent backlog and shipped history, follow the canonical doc above rather than duplicating it here.

---

## Snapshot (May 2026)

`server.js` is intentionally a **thin bootstrap**: it listens and hands off to **`lib/server-configured-app.js`**, where the composed app mounts **`routes/`** (including `routes/index.js` and per-domain modules). New HTTP behavior should land in **`lib/`** and **`routes/`**, not by growing the entry file again.

**Wire-check** is in place as **`scripts/wire-check.mjs`**, with intentional exclusions in **`routes/.wire-check-ignore`**. Ongoing work is keeping that ignore list honest—every entry should have a reason—and re-checking mounts whenever routes are renamed, split, or moved.

**Eval in CI** follows offline-first patterns: curated sets under **`data/eval-sets/`**, seeded stores, and **`npm run eval:ci`** (and related scripts) so agent-affecting changes get regression signal without requiring live keys in the default path.

**`main`** is the quality gate: lint, unit tests with coverage, **critical-file coverage** via **`scripts/check-critical-coverage.mjs`**, Trivy, and downstream smoke/eval steps **as configured in CI** (see repo workflows and [docs/RUNBOOK.md](./RUNBOOK.md) where applicable).

| Note | |
|------|---|
| Prior “lines / module counts” figures from April 2026 are **historic**—for current priorities and numbered next steps, see [AGENT_NEXT_STEPS.md](./AGENT_NEXT_STEPS.md) and the codebase. |

---

## Recommended next steps (prioritized)

Resist new surface area until consolidation work is boring and green.

### P0 — Consolidation (ship before anything new)

1. **Wire-check — landed.** Maintenance: treat **`routes/.wire-check-ignore`** as a reviewed contract; when routes move, update ignores and **wire-check** expectations so mounts stay truthful.

2. **`server.js` / bootstrap discipline.** **Stop regressing** the modular split: entry stays thin; **new behavior belongs in `lib/` + `routes/`** (and tests beside them). No milestone line-count targets—consistency beats churn.

3. **Coverage floor uplift (aspirational).** Raise global floors only when **`npm run test:coverage`** supports it. The **critical-files gate** (`scripts/check-critical-coverage.mjs`) and any **temporary per-file floors** under **`agent-tools`** are tighter levers—goal is to **restore default thresholds through real tests**, then unwind special cases.

4. **Dead-route / dead-module sweep.** Grep for **orphan `lib/`**, **unmounted or unused `routes/`**, and client references; wire, feature-flag, or delete—no permanent scaffolds. **Tooling:** **`npm run dead-route-scan`** + **`npm run dead-lib-scan`**.

### P1 — Design-partner burn-in

Substance from the code-gen / Phase-63 vertical, compressed. Verify in-repo before treating as done.

- **Golden path (E2E)** — Single scripted flow: workspace → ingest → **repo-rag** → **PR review** → **test-gen** → merge; Playwright + cost/trace budget in **`tests/e2e/`** / **`test:e2e:api`**. **Landed:** `tests/e2e/phase63-golden-path.spec.js`.
- **`pr-review-agent` HITL** — Draft when **`PR_REVIEW_HITL=1`** or **`requireApproval: true`**; approve via **`POST /pr-review/reviews/:id/approve`**. **Landed.**
- **Cost attribution** — **`lib/phase63-metering.js`** + **`lib/phase63-pricing.js`** (default `$0.01/call` rules). **Landed**; customize via pricing-engine API.
- **Eval-in-prod for Phase 63 subjects** — **`mountEvalInProdRoutes`** mounted; quality samples via **`recordPhase63QualitySample`** when `qualitySignal` metadata is present. **Landed** (alerting still ops-owned).

### P2 — Operational hardening

- **Chaos drill** — **`mountChaosEngineeringRoutes`** mounted (admin `/api/v1/chaos/*`); chaos tests in **`tests/chaos/`** + **`npm run test:chaos`**. Staging SLO drill: **`scripts/staging-drill.mjs`** + **`.github/workflows/staging-drill.yml`** (requires **`vars.STAGING_URL`**). **Landed** (run against staging when URL is configured).
- **Safety SLA backtest** — **`seedFromEvalHistory`** in **`lib/safety-sla.js`**, **`POST /safety-sla/seed-from-eval`**, CLI **`npm run seed:safety-sla`**. **Landed.**
- **Load-shed tuning** — Defaults documented in **`docs/RUNBOOK.md`**; exercise via **`npm run test:load`**. **Partial** (threshold tuning in staging still open).
- **Leader-election partition test** — **`tests/chaos/leader-partition.test.js`** (TTL takeover / no split-brain). **Landed.**

### P3 — New fronts (only after P0 + P1)

Pick **one** when consolidation and partner path are green:

- **Compliance automation** — **`mountComplianceRoutes`** mounted (admin SOC2/HIPAA/GDPR + evidence endpoints). Thicken evidence export workflows as needed. **Partial** (routes landed; automation depth still open).
- **Privacy engineering** — DP telemetry, PII preflight, erasure workflow.
- **Model lifecycle** — **`lib/model-registry.js`**: champion/challenger, auto-rollback on quality regression.

Do not run multiple greenfield tracks in parallel.

### Explicitly out of scope (this wave)

- New agent tools (eval surface is already wide).
- New integrations (Teams, Notion, …) until a partner requires them.
- Additional storage backends beyond current JSON / SQLite / Postgres stance.

---

## Execution guidance

- One PR per **P0** subtask where practical; keep reviews small.
- **P1** items ship with **code + test + doc**; missing operator doc = not done.
- Do not raise global coverage floors and open a **P3** front in the same PR.
- On PRs touching **`lib/agent-*`**, **`lib/repo-rag.js`**, **`lib/pr-review-agent.js`**, **`lib/test-gen.js`**, or **`lib/eval-*`**, run **`npm run eval:ci`** locally and align with CI eval jobs.
- Prefer **`lib/` + `routes/`** growth over **`server.js`** and monolithic route barrels.
