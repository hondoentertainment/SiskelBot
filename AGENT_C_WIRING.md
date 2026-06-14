# Agent C Wiring

Integration instructions for the 8 subtasks implemented on this worktree
(Phases 61.2, 61.3, 61.5, 62.1, 62.2, 62.3, 62.4, 62.5). Apply these changes
in `routes/index.js` and `package.json` before cutting a release.

## 1. Add to `routes/index.js`

### Imports (with the other `import` lines near the top)

```js
import { mountWebhookInspectorRoutes } from "./webhook-inspector.js";
import { mountIntegrationTestHarnessRoutes } from "./integration-test-harness.js";
import { mountSchemaRegistryRoutes } from "./schema-registry.js";
import { mountIntentClassifierRoutes } from "./intent-classifier.js";
import { mountTicketRouterRoutes } from "./ticket-router.js";
import { mountResponseDrafterRoutes } from "./response-drafter.js";
import { mountEscalationRulesRoutes } from "./escalation-rules.js";
import { mountCsatTrackerRoutes } from "./csat-tracker.js";
```

### `mountFunctions` array entries

Append these inside the existing `const mountFunctions = [ ... ];` list
(order does not matter functionally, but grouping with the other 61.x / 62.x
routes keeps the list tidy):

```js
  mountWebhookInspectorRoutes,
  mountIntegrationTestHarnessRoutes,
  mountSchemaRegistryRoutes,
  mountIntentClassifierRoutes,
  mountTicketRouterRoutes,
  mountResponseDrafterRoutes,
  mountEscalationRulesRoutes,
  mountCsatTrackerRoutes,
```

## 2. npm scripts to add to `package.json`

Add these entries to the `"scripts"` object:

```json
"test:recipes": "node scripts/test-recipes.mjs",
"schema:diff": "node scripts/schema-diff.mjs"
```

`test:recipes` expects one or more recipe JSON files as positional arguments,
e.g. `npm run test:recipes -- fixtures/my-recipe.json`.

`schema:diff` expects two JSON file paths (before, after) and exits 1 on any
breaking change — suitable for CI gating.

## 3. Endpoint cheat sheet

| Subtask | Base path |
|---------|-----------|
| 61.2 Webhook inspector | `/api/v1/webhook-inspector/*` |
| 61.3 Integration tests | `/api/v1/integration-tests/*` |
| 61.5 Schema registry | `/api/v1/schemas/*` |
| 62.1 Intent classifier | `/api/v1/intents/*` |
| 62.2 Ticket router | `/api/v1/tickets/*`, `/api/v1/ticket-queues/*` |
| 62.3 Response drafter | `/api/v1/response-drafts/*` |
| 62.4 Escalation rules | `/api/v1/escalation-rules/*` |
| 62.5 CSAT tracker | `/api/v1/csat/*` |

All routes require `adminAuth` from the shared deps object (same pattern as
the existing `lib/canary.js` / `routes/canary.js` surface).

## 4. Client asset

`client/webhook-inspector.html` is a static dashboard served by the existing
Express static middleware. No route changes are required — it is reachable
at `/webhook-inspector.html` once the client directory is served.
