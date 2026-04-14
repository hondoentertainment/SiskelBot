# Phase 75 Evaluation 2.0 — route wiring

The following five route modules were added under `routes/`. They follow the
standard `mountXRoutes(app, deps)` contract used by `routes/index.js`.

## Imports to add in `routes/index.js`

```js
import { mountEvalInProdRoutes } from "./eval-in-prod.js";
import { mountJudgeCalibrationRoutes } from "./judge-calibration.js";
import { mountPreferenceRoutes } from "./preference-collection.js";
import { mountBisectionRoutes } from "./regression-bisection.js";
import { mountSyntheticUsersRoutes } from "./synthetic-users.js";
```

## mountFunctions entries

Add these to the array passed to `mountAllRoutes` (same list style as the
existing phase route modules):

```js
mountEvalInProdRoutes(app, deps);
mountJudgeCalibrationRoutes(app, deps);
mountPreferenceRoutes(app, deps);
mountBisectionRoutes(app, deps);
mountSyntheticUsersRoutes(app, deps);
```

## Endpoints summary

### 75.1 Eval-in-prod (shadow traffic) — `routes/eval-in-prod.js`

| Method | Path |
|--------|------|
| POST   | `/eval-in-prod/samples` |
| GET    | `/eval-in-prod/samples?workspaceId=...&candidateModel=...&limit=&offset=` |
| GET    | `/eval-in-prod/stats?workspaceId=...&candidateModel=...` |
| GET    | `/eval-in-prod/config?workspaceId=...` |
| PUT    | `/eval-in-prod/config` `{ workspaceId, enabled, candidateModel, sampleRate }` |

### 75.2 Judge calibration — `routes/judge-calibration.js`

| Method | Path |
|--------|------|
| POST   | `/judge-calibration/judgements` |
| GET    | `/judge-calibration/judges` |
| GET    | `/judge-calibration/:judgeId/stats` |
| GET    | `/judge-calibration/:judgeId/matrix` |
| GET    | `/judge-calibration/:judgeId/judgements?limit=&offset=` |

### 75.3 Pairwise preference collection — `routes/preference-collection.js`

| Method | Path |
|--------|------|
| POST   | `/preference/cases` |
| GET    | `/preference/cases?workspaceId=` |
| GET    | `/preference/cases/:id` |
| POST   | `/preference/cases/:id/vote` |
| GET    | `/preference/cases/:id/stats` |
| GET    | `/preference/votes?caseId=` or `?workspaceId=` |

### 75.4 Regression bisection — `routes/regression-bisection.js`

| Method | Path |
|--------|------|
| POST   | `/bisection/sessions` |
| POST   | `/bisection/sessions/:id/advance` |
| GET    | `/bisection/sessions/:id` |
| GET    | `/bisection/sessions?workspaceId=` |

### 75.5 Synthetic user simulation — `routes/synthetic-users.js`

| Method | Path |
|--------|------|
| POST   | `/synthetic-users/personas` |
| GET    | `/synthetic-users/personas?workspaceId=` |
| POST   | `/synthetic-users/simulations` |
| POST   | `/synthetic-users/simulations/:id/turns` |
| POST   | `/synthetic-users/simulations/:id/complete` |
| POST   | `/synthetic-users/simulations/:id/score` |
| GET    | `/synthetic-users/simulations/:id` |
| GET    | `/synthetic-users/simulations?workspaceId=` |

## Lib modules

- `lib/eval-in-prod.js`
- `lib/judge-calibration.js`
- `lib/preference-collection.js`
- `lib/regression-bisection.js`
- `lib/synthetic-users.js`

Each exports a `_reset()` helper for test isolation and stores data under
`data/{module-name}/...` via `lib/json-path-store.js`.

## Tests

- `tests/eval-in-prod.test.js`
- `tests/judge-calibration.test.js`
- `tests/preference-collection.test.js`
- `tests/regression-bisection.test.js`
- `tests/synthetic-users.test.js`

Run:

```bash
node --test tests/eval-in-prod.test.js tests/judge-calibration.test.js tests/preference-collection.test.js tests/regression-bisection.test.js tests/synthetic-users.test.js
```
