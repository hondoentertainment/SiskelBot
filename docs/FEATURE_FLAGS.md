# Feature Flags

SiskelBot ships a lightweight in-house feature flag system backed by the same
`lib/storage.js` abstraction the rest of the server uses. It supports boolean,
string, number, and JSON values with per-flag targeting rules and a 30-second
in-memory cache.

## Overview

Use feature flags for runtime decisions that should be changeable without a
deploy:

- **Gradual rollouts** — expose a new code path to a percentage of users and
  ramp up while watching dashboards.
- **Kill switches** — flip a flag off when an experimental subsystem misbehaves
  in production.
- **Beta / allowlist gates** — open a feature to a specific workspace or set of
  users before general availability.
- **A/B feature gates** — branch agent behavior or UI surface area on a flag and
  compare metrics.

For permanent, deployment-wide configuration prefer environment variables. Use a
flag when the answer can change at runtime, varies by tenant or user, or is
intentionally temporary.

## Targeting rules

Each flag is stored as:

```json
{
  "key": "experimental_swarm",
  "enabled": true,
  "value": true,
  "defaultValue": false,
  "targeting": {
    "workspaces": ["acme-corp"],
    "users": ["user-uuid"],
    "percentage": 25,
    "startDate": "2026-01-01T00:00:00Z",
    "endDate": "2026-12-31T23:59:59Z"
  },
  "description": "Use new swarm engine"
}
```

Evaluation order:

1. **`enabled: false`** — the flag always returns `defaultValue` (effectively
   off). This is the kill switch.
2. **Date window** — `startDate` / `endDate` (ISO 8601). Outside the window the
   flag returns `defaultValue`.
3. **Workspace allowlist** — if `targeting.workspaces` is non-empty the caller's
   `workspaceId` must be in the list. A match short-circuits to `value`.
4. **User allowlist** — if `targeting.users` is non-empty and the caller's
   `userId` is in the list, the flag returns `value`. Otherwise evaluation
   continues to the percentage rollout (if any).
5. **Percentage rollout** — `targeting.percentage` (0-100). Bucketing is
   deterministic via `sha256(key + "\0" + userId) % 100`, so the same user
   always lands in the same bucket. Anonymous callers (no `userId`) only match
   at `100`.
6. **No rules at all** — an `enabled: true` flag with empty targeting returns
   `value` for every caller.

### Examples

**Pure kill switch (disabled by default):**

```json
{ "key": "new_indexer", "enabled": true, "value": true, "defaultValue": false, "targeting": {} }
```

**Workspace allowlist:**

```json
{
  "key": "vip_priority_routing",
  "enabled": true,
  "value": true,
  "defaultValue": false,
  "targeting": { "workspaces": ["acme-corp", "globex"] }
}
```

**5% canary rollout:**

```json
{
  "key": "experimental_swarm",
  "enabled": true,
  "value": true,
  "defaultValue": false,
  "targeting": { "percentage": 5 }
}
```

**Time-boxed beta:**

```json
{
  "key": "summer_promo_banner",
  "enabled": true,
  "value": "show",
  "defaultValue": "hide",
  "targeting": {
    "startDate": "2026-06-01T00:00:00Z",
    "endDate": "2026-08-31T23:59:59Z"
  }
}
```

## API

All admin endpoints require a session that passes `adminAuth` and the `admin`
scope. The evaluation endpoint is for authenticated callers checking their own
flag state.

| Method | Path                                  | Purpose                          |
| ------ | ------------------------------------- | -------------------------------- |
| GET    | `/api/v1/admin/feature-flags`         | List all flags                   |
| GET    | `/api/v1/admin/feature-flags/:key`    | Fetch one flag's full definition |
| PUT    | `/api/v1/admin/feature-flags/:key`    | Create or update a flag          |
| DELETE | `/api/v1/admin/feature-flags/:key`    | Delete a flag                    |
| GET    | `/api/v1/feature-flags/:key/evaluate` | Evaluate flag for current caller |

The legacy `/api/...` paths also work and emit `X-API-Deprecated`. Prefer
`/api/v1/...`.

### Create / update a flag

```bash
curl -X PUT https://siskelbot.example.com/api/v1/admin/feature-flags/experimental_swarm \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "value": true,
    "defaultValue": false,
    "targeting": { "percentage": 25 },
    "description": "Use new swarm engine"
  }'
```

### Evaluate a flag (client-facing)

```bash
curl https://siskelbot.example.com/api/v1/feature-flags/experimental_swarm/evaluate?workspace=acme-corp \
  -H "Authorization: Bearer $USER_TOKEN"
# { "key": "experimental_swarm", "value": true }
```

The evaluator returns the resolved value (which may be `value`, `defaultValue`,
or `undefined` if the flag does not exist).

## Using flags in code

Import directly from `lib/feature-flags.js` and pass the same `storage` module
every other route uses (it comes through `deps` in route modules).

```javascript
import { isEnabled, getFlag } from "./lib/feature-flags.js";

if (await isEnabled(storage, "experimental_swarm", { userId, workspaceId })) {
  // new path
} else {
  // current path
}

// Non-boolean flag:
const variant = await getFlag(storage, "ui_variant", { userId, workspaceId });
if (variant === "compact") {
  /* ... */
}
```

`isEnabled` returns `true` only when the resolved value is strictly `true`.
For string / number / JSON flags use `getFlag` and compare explicitly.

## Cache

Resolved flag values are cached in-process for **30 seconds** keyed by
`(flag key, workspaceId, userId)`. The cache is invalidated immediately when a
flag is created, updated, or deleted via `setFlag` / `deleteFlag`, so admin
edits propagate without waiting for the TTL on the same replica. In multi-replica
deployments other replicas pick up the change after the 30-second TTL elapses.

A 30-second window is chosen as a compromise between storage pressure (flag
checks live on hot paths) and operator responsiveness (kill switches still flip
within a half minute fleet-wide).

## Lifecycle

Feature flags accumulate technical debt if left unattended. Treat each flag as a
todo item with an owner and an exit date.

- **Naming**: prefix temporary flags with `temp_` (e.g.
  `temp_new_billing_flow`). Keep `experimental_*` for opt-in beta features.
- **Review monthly**: as part of ops review walk
  `GET /api/v1/admin/feature-flags` and confirm each flag still has a reason to
  exist.
- **Remove within 90 days of full rollout**: once a flag is at `percentage: 100`
  or has been at `enabled: true / value: true` everywhere for a release cycle,
  delete the flag *and* the conditional in the code. A stale flag is a foot-gun.
- **Document the owner**: use the `description` field to record both the
  intent and the team / person responsible for retiring the flag.

## When to use a flag vs an env var

| Property                         | Env var               | Feature flag           |
| -------------------------------- | --------------------- | ---------------------- |
| Changes between deploys?         | Rare                  | Frequent               |
| Per-tenant / per-user variation? | No                    | Yes                    |
| Gradual rollout?                 | No                    | Yes (`percentage`)     |
| Operator visibility              | `.env.example`, infra | Admin API + audit log  |
| Lifetime                         | Permanent             | Temporary by default   |
| Override at runtime              | Restart required      | Hot-swappable (≤ 30 s) |

If a knob is genuinely permanent — e.g. a backend URL, an API key, a cluster
sizing parameter — it belongs in `.env.example` and should *not* be a feature
flag.
