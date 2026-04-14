# Phase 72 Trust & Safety Pro — Wiring Notes

This worktree implements Phase 72 (Trust & Safety Pro) as five independent
modules plus their routes and tests. The modules are not yet wired into
`routes/index.js` or `server.js` — follow the steps below when merging.

## Modules delivered

| # | Module | Lib | Routes | Tests |
|---|--------|-----|--------|-------|
| 72.1 | Red-team harness | `lib/red-team-harness.js` | `routes/red-team-harness.js` | `tests/red-team-harness.test.js` |
| 72.2 | Model card generator | `lib/model-card-generator.js` | `routes/model-card-generator.js` | `tests/model-card-generator.test.js` |
| 72.3 | Bias eval suite | `lib/bias-eval-suite.js` | `routes/bias-eval-suite.js` | `tests/bias-eval-suite.test.js` |
| 72.4 | k-anonymous telemetry | `lib/k-anonymous-telemetry.js` | `routes/k-anonymous-telemetry.js` | `tests/k-anonymous-telemetry.test.js` |
| 72.5 | Safety SLA dashboard | `lib/safety-sla.js` | `routes/safety-sla.js` | `tests/safety-sla.test.js` |

## Wiring into `routes/index.js`

Add the imports and `mountAllRoutes` calls:

```js
import mountRedTeamRoutes from "./red-team-harness.js";
import mountModelCardRoutes from "./model-card-generator.js";
import mountBiasEvalRoutes from "./bias-eval-suite.js";
import mountKTelemetryRoutes from "./k-anonymous-telemetry.js";
import mountSafetySlaRoutes from "./safety-sla.js";

// inside mountAllRoutes(app, deps):
mountRedTeamRoutes(app, deps);
mountModelCardRoutes(app, deps);
mountBiasEvalRoutes(app, deps);
mountKTelemetryRoutes(app, deps);
mountSafetySlaRoutes(app, deps);
```

No changes required to `server.js` or `package.json` — all modules use the
existing `apiRoute`, `apiError`, `logRequest`, `adminAuth` deps and the
`lib/json-path-store.js` storage facade.

## Endpoints

### 72.1 Red-team harness

- `GET  /api/v1/red-team/categories`
- `POST /api/v1/red-team/probes` — `{ category, count, seed? }`
- `POST /api/v1/red-team/runs` — `{ workspaceId, modelId, categories, probeCount }`
- `POST /api/v1/red-team/runs/:runId/results` — `{ probeId, response, blocked, classifierScore? }`
- `GET  /api/v1/red-team/runs/:runId`
- `GET  /api/v1/red-team/runs/:runId/summary`
- `GET  /api/v1/red-team/runs?workspaceId=`

### 72.2 Model card generator

- `POST  /api/v1/model-cards` — `{ modelId, metadata }`
- `GET   /api/v1/model-cards`
- `GET   /api/v1/model-cards/:modelId`
- `PATCH /api/v1/model-cards/:modelId` — `{ field, value }`
- `GET   /api/v1/model-cards/:modelId/markdown`

### 72.3 Bias eval suite

- `POST /api/v1/bias-eval/personas` — `{ workspaceId, name, demographics }`
- `GET  /api/v1/bias-eval/personas?workspaceId=`
- `POST /api/v1/bias-eval/runs` — `{ workspaceId, modelId, prompts, personas }`
- `POST /api/v1/bias-eval/runs/:runId/responses` — `{ personaId, prompt, response }`
- `GET  /api/v1/bias-eval/runs/:runId/report`
- `GET  /api/v1/bias-eval/runs?workspaceId=`

### 72.4 k-anonymous telemetry

- `POST /api/v1/k-telemetry/events` — `{ eventName, dimensions, userId }`
- `POST /api/v1/k-telemetry/aggregate` — `{ eventName, dimensions, k? }`
- `GET  /api/v1/k-telemetry/config`
- `PUT  /api/v1/k-telemetry/config` — `{ k }`
- `GET  /api/v1/k-telemetry/buckets?eventName=`

### 72.5 Safety SLA dashboard

- `POST /api/v1/safety-sla/classifications` — `{ classifierId, prediction, actual, timestamp? }`
- `PUT  /api/v1/safety-sla/:classifierId/target` — `{ precisionTarget, recallTarget }`
- `GET  /api/v1/safety-sla/:classifierId/target`
- `GET  /api/v1/safety-sla/:classifierId/metrics?since=&until=`
- `GET  /api/v1/safety-sla/:classifierId/status`
- `GET  /api/v1/safety-sla/classifiers`

## Storage layout

Each module stores JSON under `data/` (or the configured `STORAGE_PATH`):

- `data/red-team/{workspaceId}.json`, `data/red-team/_index.json`
- `data/model-cards/cards.json`
- `data/bias-eval/{workspaceId}.json`, `data/bias-eval/_index.json`
- `data/k-telemetry/config.json`, `data/k-telemetry/{eventName}.json`, `data/k-telemetry/_index.json`
- `data/safety-sla/classifiers.json`

## Safety notes on red-team probes

The red-team harness stores only benign placeholder templates. Every probe
expands the `[BENIGN_PLACEHOLDER]` token to a neutral string such as
`"benign task 7"`. No harmful corpora is checked into the tree — the
purpose of the harness is to probe jailbreak-style framing, not to supply
harmful payloads.

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `BIAS_DISPARITY_THRESHOLD` | Flag prompts whose persona-to-persona Jaccard disparity exceeds this value | `0.5` |
| `SAFETY_SLA_MAX_RECORDS` | Ring-buffer size for per-classifier outcome records | `10000` |

## Tests

```
node --test tests/red-team-harness.test.js \
            tests/model-card-generator.test.js \
            tests/bias-eval-suite.test.js \
            tests/k-anonymous-telemetry.test.js \
            tests/safety-sla.test.js
```

All 43 tests pass.
