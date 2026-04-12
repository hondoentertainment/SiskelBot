# Agent A: wiring instructions for `routes/index.js`

The 11 new route modules below were NOT registered in `routes/index.js` per
the worktree rules. To turn them on, add the following imports and
`mountFunctions` entries to `routes/index.js`.

## Imports to add

Paste these alongside the other route-module imports (anywhere in the block,
order does not matter to Express):

```js
import { mountPolicyAuditRoutes } from "./policy-audit.js";
import { mountRiskyOpsQuotaRoutes } from "./risky-ops-quota.js";
import { mountNeuroSymbolicRoutes } from "./neuro-symbolic.js";
import { mountDagPipelineRoutes } from "./dag-pipeline.js";
import { mountDataQualityRoutes } from "./data-quality.js";
import { mountSchemaEvolutionRoutes } from "./schema-evolution.js";
import { mountLineageRoutes } from "./lineage.js";
import { mountFeatureStoreRoutes } from "./feature-store.js";
import { mountCostAwareRouterRoutes } from "./cost-aware-router.js";
import { mountPromptCompressionRoutes } from "./prompt-compression.js";
import { mountDistillationRoutes } from "./distillation.js";
```

## `mountFunctions` entries to add

Append these inside the existing `mountFunctions = [ ... ]` array:

```js
  mountPolicyAuditRoutes,
  mountRiskyOpsQuotaRoutes,
  mountNeuroSymbolicRoutes,
  mountDagPipelineRoutes,
  mountDataQualityRoutes,
  mountSchemaEvolutionRoutes,
  mountLineageRoutes,
  mountFeatureStoreRoutes,
  mountCostAwareRouterRoutes,
  mountPromptCompressionRoutes,
  mountDistillationRoutes,
```

## Route surface summary

| Phase | Module | Key routes |
|-------|--------|-----------|
| 51.4  | `policy-audit`         | POST/GET `/api/v1/policy-audit/decisions`, `/stats`, `/export` |
| 51.5  | `risky-ops-quota`      | GET `/tiers`, `/quota/check`; POST `/quota/consume`, `/operations/:op/tier`; GET `/counters` |
| 52.4  | `neuro-symbolic`       | GET `/solvers`; POST `/sat`, `/smt` |
| 57.1  | `dag-pipeline`         | POST/GET `/dag-pipelines`, `/:id/run`, `/runs/:runId`, `/tasks` |
| 57.2  | `data-quality`         | POST `/monitors`, `/:name/samples`, `/:name/reference`; GET `/monitors/:name/drift` |
| 57.3  | `schema-evolution`     | POST `/subjects/:subject` (register); GET `/subjects[/…]`; POST `/check` |
| 57.4  | `lineage`              | POST `/events`; GET `/events`, `/graph` |
| 57.5  | `feature-store`        | POST `/features`, `/:name/values`, `/batch-read`; GET `/:name/values/:entity`, `/:name/offline` |
| 58.1  | `cost-aware-router`    | POST `/cost-router/pick`, `/cost`, `/config`; GET `/report`, `/config` |
| 58.3  | `prompt-compression`   | POST `/compress`, `/estimate`; GET `/modes` (honors `PROMPT_COMPRESSION=1`) |
| 58.4  | `distillation`         | POST `/runs`, `/:id/pairs`, `/:id/finalize`, `/:id/promote`, `/:id/cancel`; GET `/runs[/:id[/dataset]]` |

All routes require `adminAuth` and use the shared `apiRoute`, `apiError`,
`logRequest` helpers from the existing `deps` object.

## New env vars (all optional)

- `POLICY_AUDIT_MAX_ENTRIES` — ring-buffer cap per workspace (default 10000)
- `QUOTA_TIER_SAFE_PER_MIN`, `QUOTA_TIER_COSTLY_PER_MIN`, `QUOTA_TIER_RISKY_PER_MIN`, `QUOTA_TIER_DESTRUCTIVE_PER_HOUR`
- `LINEAGE_MAX_EVENTS` — ring-buffer cap (default 20000)
- `FEATURE_STORE_MAX_OFFLINE` — offline-log cap per feature (default 100000)
- `COST_ROUTER_MAX_ENTRIES` — usage-log cap (default 20000)
- `PROMPT_COMPRESSION` — `1` to enable compression; off by default
- `DISTILLATION_MAX_PAIRS` — dataset cap per run (default 200000)

## Non-breaking library wiring (already applied)

The three existing safety modules now also mirror their decisions into the
unified policy-audit trail (Phase 51.4). The changes are additive and wrapped
in try/catch so audit failures never affect the hot path:

- `lib/jailbreak-detector.js` — `logDetection` mirrors into `recordDecision`
- `lib/output-classifiers.js` — `logClassificationEvent` mirrors into `recordDecision`
- `lib/constitutional-ai.js` — `applyConstitution` mirrors final action (`allow`/`revise`/`block`) into `recordDecision`

All 94 existing tests in those three suites continue to pass.
