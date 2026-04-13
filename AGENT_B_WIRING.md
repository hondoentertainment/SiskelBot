# AGENT_B_WIRING

This document lists the exact imports and `mountFunctions` entries that should be added to `routes/index.js` to expose the six new route modules implemented under Phases 59.2 and 60.1–60.5.

`server.js`, `package.json`, and `routes/index.js` were left untouched per the contract. The maintainer should insert the lines below into `routes/index.js` alongside the existing `mountCanary` / `mountErrorBudget` wiring (nearby imports near lines 180–186 and the `mountFunctions` array near lines 329–333).

## Imports to add (top of `routes/index.js`)

```js
import { mountLoadSheddingRoutes } from "./load-shedding.js";
import { mountProfilingRoutes } from "./profiling.js";
import { mountHeapDiffRoutes } from "./heap-diff.js";
import { mountStepLatencyRoutes } from "./step-latency.js";
import { mountLogAnalysisRoutes } from "./log-analysis.js";
import { mountStatusPageRoutes } from "./status-page.js";
```

All six modules also provide a `default` export, so `import mountFoo from "./foo.js"` also works if that style is preferred.

## `mountFunctions` entries to add

Append these after the existing `mountCanaryRoutes` entry (they can be inserted in any order, but keep them together for easy discovery):

```js
  mountLoadSheddingRoutes,
  mountProfilingRoutes,
  mountHeapDiffRoutes,
  mountStepLatencyRoutes,
  mountLogAnalysisRoutes,
  mountStatusPageRoutes,
```

## Dependency expectations

Every new route module pulls the same shared deps as the existing admin-gated modules:

```js
const { apiRoute, apiError, logRequest, adminAuth } = deps;
```

No new deps are required. All persistent state lives under `data/<module>/` via `lib/json-path-store.js`, matching existing conventions.

## Public route note (status page)

`routes/status-page.js` is intentionally split: a small set of GET endpoints under `/api/v1/status*` are public (no `adminAuth`) so the status page HTML can read them anonymously. The admin mutation routes inside the same file still require `adminAuth`. The HTML page is served from the existing static directory as `client/status.html` — no route changes needed if static serving of `client/` is already enabled in `server.js`.

## New routes summary

| Module | Prefix | Auth |
|--------|--------|------|
| `load-shedding` | `/api/v1/load-shedding/*` | admin |
| `profiling` | `/api/v1/profiling/*` | admin |
| `heap-diff` | `/api/v1/heap-diff/*` | admin |
| `step-latency` | `/api/v1/step-latency/*` | admin |
| `log-analysis` | `/api/v1/log-analysis/*` | admin |
| `status-page` | `/api/v1/status*` | public read / admin write |

## Optional integration hints

- **Load shedding:** mount the middleware early in `server.js` to protect expensive routes:
  ```js
  import { admitRequest, PRIORITY_P2 } from "./lib/load-shedding.js";
  app.use("/v1/chat/completions", admitRequest(PRIORITY_P2));
  app.use("/health", admitRequest(0)); // P0
  ```
- **Step latency:** call `attachSpanListener` once at boot and point it at whatever SpanProcessor hook is being used by `lib/tracing-spans.js`. The default shape expects an OTel-style span with `attributes["siskel.cortex"]` and `attributes["siskel.tool"]`.
- **Log analysis:** pipe existing console/log streams into `ingestLogs(...)`. The module does not replace or tap the logger; the caller decides the feed.
- **Status page:** add a convenience redirect from `/status` to `/status.html` for friendlier URLs.
