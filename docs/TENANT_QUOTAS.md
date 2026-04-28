# Tenant quotas

Per-workspace rate limits and usage caps enforced by `lib/tenant-quotas.js`.
Hooks into the chat completion path and is exposed for admins via
`/api/v1/admin/quotas/*`.

## What is tracked

| Metric                  | Window     | Scope        |
|-------------------------|------------|--------------|
| `requestsPerMinute`     | 60 seconds | workspace    |
| `tokensPerDay`          | 24 hours   | workspace    |
| `storageBytesMax`       | n/a (cap)  | workspace    |

Counters are kept in-memory per process. Persisted overrides (per-workspace
limit overrides) live in storage under the `tenant_quotas` collection.

## Defaults

Defaults are read from environment variables at module load:

```bash
DEFAULT_REQUESTS_PER_MINUTE=60
DEFAULT_TOKENS_PER_DAY=1000000
DEFAULT_STORAGE_BYTES_MAX=1073741824   # 1 GiB
```

## Per-workspace overrides

Use the admin API to override the defaults for a specific workspace.

### Get effective quotas + usage

```http
GET /api/v1/admin/quotas/:workspaceId
Authorization: Bearer <ADMIN_API_KEY>
```

Response:

```json
{
  "workspaceId": "team-acme",
  "limits": {
    "requestsPerMinute": 600,
    "tokensPerDay": 50000000,
    "storageBytesMax": 10737418240
  },
  "usage": {
    "requestsThisMinute": 12,
    "tokensToday": 184302,
    "storageBytes": 2840192
  }
}
```

### Set / update overrides

```http
PUT /api/v1/admin/quotas/:workspaceId
Content-Type: application/json

{
  "requestsPerMinute": 600,
  "tokensPerDay": 50000000,
  "storageBytesMax": 10737418240
}
```

Body fields are all optional; omitted fields fall back to the env defaults.
All values must be positive integers.

### Remove an override

```http
DELETE /api/v1/admin/quotas/:workspaceId
```

After deletion the workspace falls back to env defaults.

### List all workspaces with overrides

```http
GET /api/v1/admin/quotas
```

## Quota-exceeded response

When the chat completion endpoint denies a request, it returns HTTP 429 with a
`Retry-After` header:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json

{
  "error": "requests_per_minute_exceeded",
  "code": "QUOTA_EXCEEDED",
  "hint": "{\"currentUsage\":{\"requestsThisMinute\":60},\"limits\":{\"requestsPerMinute\":60,\"tokensPerDay\":1000000,\"storageBytesMax\":1073741824}}"
}
```

`reason` is one of: `requests_per_minute_exceeded`, `tokens_per_day_exceeded`.

## Monitoring

> TODO follow-up: emit a Prometheus counter `siskelbot_quota_denials_total`
> labeled by `workspace_id` and `reason` from `lib/metrics.js` whenever
> `checkQuota` returns `allowed: false`. Tracked separately.

Until then, denials are visible in request logs (status 429 with
`code: QUOTA_EXCEEDED`) and via the admin endpoint live snapshot.

## Tier examples

These are suggested values — set per-workspace via `PUT /api/v1/admin/quotas/:workspaceId`.

| Tier        | requestsPerMinute | tokensPerDay   | storageBytesMax       |
|-------------|------------------:|---------------:|----------------------:|
| free        | 30                | 100,000        | 100 MiB (104857600)   |
| pro         | 300               | 5,000,000      | 5 GiB (5368709120)    |
| enterprise  | 3,000             | 100,000,000    | 100 GiB (107374182400)|

For larger plans, prefer raising `tokensPerDay` first since real-world load
tends to be token-bound rather than request-bound.
