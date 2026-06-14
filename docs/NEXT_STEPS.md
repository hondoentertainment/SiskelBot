# SiskelBot — Recommended Next Steps (consolidation & depth)



**Status date:** 2026-05-21



**Canonical agent-focused list:** [docs/AGENT_NEXT_STEPS.md](./AGENT_NEXT_STEPS.md); **programs:** [docs/AGENT_WORLD_CLASS_ROADMAP.md](./AGENT_WORLD_CLASS_ROADMAP.md)



---



## Snapshot (May 2026)



`server.js` is a **thin bootstrap**; HTTP lives in **`lib/`** + **`routes/`**. Wire-check, dead-route-scan, and dead-lib-scan (with **`lib/.dead-lib-allowlist`**) run in CI lint.



**Phase 63 partner burn-in:** [docs/PARTNER_BURNIN.md](./PARTNER_BURNIN.md) — golden E2E, `npm run partner-check`, eval-in-prod alerts, HITL, metering.



**Ops routes mounted:** chaos, safety-sla, compliance, load-shedding, eval-in-prod.



---



## Recommended next steps (prioritized)



### P0 — Consolidation



1. **Wire-check / dead scans — landed in CI.** Maintain **`routes/.wire-check-ignore`** and **`lib/.dead-lib-allowlist`**.

2. **Bootstrap discipline** — no `server.js` bloat.

3. **Coverage uplift** — raise **`lib/agent-tools.js`** toward default 80/70 floors; remove **`PER_FILE_THRESHOLDS`** override when green.

4. **Branch protection** — apply [docs/BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md).



### P1 — Design-partner burn-in



- **Golden path E2E** — **Landed** (`tests/e2e/phase63-golden-path.spec.js`).

- **HITL / metering / eval-in-prod** — **Landed**; alerting via **`GET /eval-in-prod/alerts`** + webhook env.

- **Partner check script** — **Landed** (`npm run partner-check`); runs in CI smoke job.

- **Ops:** enable `PR_REVIEW_HITL=1` for partner; set `EVAL_IN_PROD_ALERT_WEBHOOK`.



### P2 — Operational hardening



- **Chaos / staging drill / safety SLA seed / leader partition** — **Landed** (see prior docs).

- **Load-shedding** — **Mounted**; staging profile via **`LOAD_SHEDDING_PROFILE=staging`**.

- **Open:** tune thresholds in staging under real load (`npm run test:load`).



### P3 — Compliance automation



- **Routes + weekly evidence workflow** — **Landed** (`.github/workflows/compliance-evidence.yml`, `npm run compliance:collect`).

- **Open:** S3 export, scheduled prod collect via admin API + secrets.



### Production (manual)



Set on Vercel: **`API_KEY`**, **`ADMIN_API_KEY`**, durable storage, **`REQUIRE_DURABLE_STORAGE=1`**. Run **`npm run setup:production-env`** for commands.



### Agent program (parallel)



Phase 6 browser, Phase 8b re-plan, TypeScript widen, observability dashboard — see [AGENT_NEXT_STEPS.md](./AGENT_NEXT_STEPS.md).



---



## Execution guidance



- One PR per subtask where practical.

- **`npm run eval:ci`** on agent/Phase-63 touch PRs.

- Do not open multiple P3 greenfield tracks in parallel.

