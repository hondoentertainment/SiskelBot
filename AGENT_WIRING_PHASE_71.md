# Agent Wiring — Phase 71 (Agent Economics)

This document describes the wiring required to expose the Phase 71 modules over
HTTP. Per the phase's hard constraints, `routes/index.js`, `server.js`, and
`package.json` were not modified in this worktree. The steps below should be
applied when integrating this phase into a parent branch.

## Overview

Phase 71 introduces five modules that together form the agent economics layer:

| Subtask | Lib module | Route module | Purpose |
|---------|------------|--------------|---------|
| 71.1    | `lib/pricing-engine.js`        | `routes/pricing-engine.js`        | Usage-based pricing rules & cost computation |
| 71.2    | `lib/outcome-verification.js`  | `routes/outcome-verification.js`  | Evaluate agent outcomes against criteria |
| 71.3    | `lib/revenue-share.js`         | `routes/revenue-share.js`         | Plugin / recipe / template author royalties |
| 71.4    | `lib/credit-system.js`         | `routes/credit-system.js`         | Prepaid credit balances and transactions |
| 71.5    | `lib/invoicing.js`             | `routes/invoicing.js`             | Invoice / receipt generation |

All five modules:

- Use integer cents internally for money, return USD decimals at the API edge.
- Expose `_reset()` for test isolation.
- Require admin auth on every mutating endpoint.
- Serialize writes through `withPathLock` against the JSON-path store (so they
  automatically inherit the Postgres / SQLite / JSON backend selection).

## Wiring into `routes/index.js`

Add imports alongside the existing `// Phase 51-70 closeout` block:

```js
// Phase 71 — Agent Economics
import mountPricingRoutes from "./pricing-engine.js";
import mountOutcomeRoutes from "./outcome-verification.js";
import mountRevenueShareRoutes from "./revenue-share.js";
import mountCreditRoutes from "./credit-system.js";
import mountInvoicingRoutes from "./invoicing.js";
```

Then add them to the `mountAllRoutes` mount list (the array of route mounts
passed to the Express app):

```js
  // Phase 71 — Agent Economics
  mountPricingRoutes,
  mountOutcomeRoutes,
  mountRevenueShareRoutes,
  mountCreditRoutes,
  mountInvoicingRoutes,
```

Each mount function follows the standard SiskelBot contract:

```js
export function mountXRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;
  // ...
}
```

No new deps are required beyond what `mountAllRoutes` already supplies.

## Endpoint map

All endpoints are mounted at `/api/v1/...` (and also at the legacy `/api/...`
path via `dualRegister` if the existing helper is used).

### 71.1 Pricing engine

| Method | Path | Body / query |
|--------|------|--------------|
| POST   | `/pricing/rules`        | `{ workspaceId?, ruleId?, unit, rate, modelId?, tier? }` |
| GET    | `/pricing/rules`        | `?workspaceId=` |
| GET    | `/pricing/rules/:id`    | — |
| DELETE | `/pricing/rules/:id`    | — |
| POST   | `/pricing/compute`      | `{ workspaceId, usage: { modelId?, inputTokens, outputTokens, calls, outcomes, minutes } }` |

Supported units: `input_token`, `output_token`, `call`, `outcome`, `minute`,
`flat`. A rule with `modelId: null` matches all models; a rule with a specific
`modelId` only matches when the usage record's `modelId` is equal. `flat`
rules always charge exactly once (`quantity=1`).

### 71.2 Outcome verification

| Method | Path | Body / query |
|--------|------|--------------|
| POST   | `/outcomes`                         | `{ workspaceId?, outcomeId?, name, criteria, description? }` |
| GET    | `/outcomes`                         | `?workspaceId=` |
| GET    | `/outcomes/:id`                     | — |
| POST   | `/outcomes/:id/verify`              | `{ runId?, signals }` |
| GET    | `/outcomes/verifications/:id`       | — |
| GET    | `/outcomes/verifications`           | `?workspaceId=&outcomeId=` |

Criterion types: `contains`, `not_contains`, `equals`, `regex`, `numeric_gte`,
`numeric_lte`. Scoring: `score = sum(matched_weights) / sum(all_weights)`,
`passed = (score === 1.0)`. Each verification also records a `confidence`
value derived from criterion count and total weight.

**Ordering note:** the route module registers
`GET /outcomes/verifications/:id` and `GET /outcomes/verifications` *before*
`GET /outcomes/:id` so that the path matcher resolves the verification lookups
ahead of the generic outcome lookup.

### 71.3 Revenue share

| Method | Path | Body / query |
|--------|------|--------------|
| POST   | `/revenue-share/authors`                             | `{ authorId, name, payoutMethod, defaultRate? }` |
| GET    | `/revenue-share/authors`                             | — |
| GET    | `/revenue-share/authors/:id`                         | — |
| PUT    | `/revenue-share/authors/:id/rate`                    | `{ rate }` |
| POST   | `/revenue-share/usage`                               | `{ authorId, type, units, grossAmount, reference?, timestamp? }` |
| POST   | `/revenue-share/authors/:id/compute-payout`          | `{ period: { start, end } }` |
| POST   | `/revenue-share/authors/:id/payouts`                 | `{ period, amount, reference? }` |
| GET    | `/revenue-share/authors/:id/payouts`                 | — |

Usage types: `plugin`, `recipe`, `template`, `other`. `rate` is clamped to
`[0, 1]`.

### 71.4 Credit system

| Method | Path | Body / query |
|--------|------|--------------|
| POST   | `/credits/add`                           | `{ userId, amount, source, reference? }` |
| POST   | `/credits/consume`                       | `{ userId, amount, reason, reference? }` |
| POST   | `/credits/refund`                        | `{ userId, transactionId }` |
| GET    | `/credits/:userId/balance`               | — |
| GET    | `/credits/:userId/transactions`          | `?type=&limit=&offset=` |

Transactions are append-only (`add`, `consume`, `refund`). `consume` that
would drive the balance below zero fails fast with HTTP 402
(`INSUFFICIENT_CREDITS`). Refunds are only valid against `consume`
transactions and cannot be issued twice for the same original transaction.

### 71.5 Invoicing

| Method | Path | Body / query |
|--------|------|--------------|
| POST   | `/invoices`                       | `{ workspaceId, periodStart, periodEnd, lineItems, currency?, taxRate?, customer? }` |
| GET    | `/invoices`                       | `?workspaceId=` |
| GET    | `/invoices/:id`                   | — |
| POST   | `/invoices/:id/paid`              | `{ paymentReference, paidAt? }` |
| POST   | `/invoices/:id/void`              | `{ reason }` |
| GET    | `/invoices/:id/export`            | `?format=json\|text` |

Invoice numbers are monotonic per workspace. A paid invoice cannot be voided;
a void invoice cannot be marked paid. `exportInvoiceText` renders a fixed-
width plain-text receipt suitable for email or download.

## Storage layout

Every module scopes state under `getDataDir()`:

```
data/pricing-engine/{workspaceId}.json
data/pricing-engine/_index.json
data/pricing-engine/_rule-index.json

data/outcome-verification/outcomes/{workspaceId}.json
data/outcome-verification/verifications/{workspaceId}.json
data/outcome-verification/_outcome-index.json
data/outcome-verification/_workspace-index.json

data/revenue-share/authors.json
data/revenue-share/usage/{authorId}.json
data/revenue-share/payouts/{authorId}.json

data/credit-system/transactions/{userId}.json
data/credit-system/balances/{userId}.json
data/credit-system/_users.json
data/credit-system/_tx-index.json

data/invoicing/{workspaceId}.json
data/invoicing/_counters.json
data/invoicing/_index.json
data/invoicing/_workspaces.json
```

When `STORAGE_BACKEND=sqlite` or `postgres` is set, the same logical paths are
used as KV keys automatically via `lib/json-path-store.js` — no per-module
changes required.

## Validation

All tests pass locally:

```
node --test tests/pricing-engine.test.js \
            tests/outcome-verification.test.js \
            tests/revenue-share.test.js \
            tests/credit-system.test.js \
            tests/invoicing.test.js
# => 55/55 pass
```
