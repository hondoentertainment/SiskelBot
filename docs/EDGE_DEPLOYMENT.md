# Edge deployment (Phase 35.5)

SiskelBot can run a thin "edge" layer in front of the origin Express
server to serve read-only endpoints from a CDN POP close to the user.
This document covers the Cloudflare Workers and Fastly VCL variants.

## Why edge caching

- **Latency.** Read endpoints like `/config`, `/api/v1/recipes`,
  `/api/v1/knowledge/search`, and `/api/docs/openapi.json` can be served
  from a POP within ~20ms of the user instead of a single origin region.
- **Cost.** Cached requests do not hit the origin at all — Express CPU,
  storage I/O, and outbound bandwidth are all avoided.
- **Availability.** When the origin is briefly down, the edge can keep
  serving stale-but-valid responses (`stale-while-revalidate`,
  `stale-if-error`) so dashboards and CLI tools keep working.
- **DDoS absorption.** Cloudflare/Fastly absorb floods on cacheable
  paths without forwarding them to your origin.

## What gets cached

| Path                          | TTL    | Vary on            | Why |
|-------------------------------|--------|--------------------|-----|
| `/health/live`                | edge   | (none)             | served entirely from the worker, never hits origin |
| `/config`                     | 30s    | (none)             | small, mostly static, used on every page load |
| `/api/v1/knowledge/search`    | 60s    | `q`, `workspace`   | safe to be a few seconds stale |
| `/api/v1/recipes`             | 60s    | `workspace`        | recipe lists rarely change |
| `/api/docs/openapi.json`      | 1h     | (none)             | regenerated only on deploys |
| `/metrics`                    | (none) |                    | always proxied to origin (Prometheus needs fresh data) |

All other GETs and every write (POST/PUT/PATCH/DELETE) are passed
through to the origin without caching. Requests that carry an
`Authorization`, `x-api-key`, or `Cookie` header always bypass the
cache to avoid leaking per-user content across users.

## Cloudflare Workers setup

### 1. Install wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Configure the worker

The configuration lives in `edge/cloudflare/wrangler.toml`. Update the
following before deploying:

- `[vars] ORIGIN_URL` — the public hostname of your Express origin.
- `[[routes]]` — the zone and pattern that should invoke the worker.

```toml
name = "siskelbot-edge"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
ORIGIN_URL = "https://api.siskelbot.example.com"

[[routes]]
pattern = "siskelbot.example.com/*"
zone_name = "siskelbot.example.com"
```

### 3. Deploy

```bash
cd edge/cloudflare
wrangler deploy            # production
wrangler deploy -e staging # staging variant defined in wrangler.toml
```

### 4. Validate

```bash
curl -i https://siskelbot.example.com/health/live
# X-Edge: cloudflare
# X-Edge-Cache: BYPASS
# {"status":"ok","edge":"cloudflare"}

curl -i https://siskelbot.example.com/config
# First request:  X-Edge-Cache: MISS
# Second request: X-Edge-Cache: HIT
```

## Fastly VCL setup

### 1. Create the service

In the Fastly UI (or via the `terraform-provider-fastly`):

1. Create a new service for your domain.
2. Add the origin host (`api.siskelbot.example.com`) as the backend.
3. Upload `edge/fastly/fastly.vcl` as a custom VCL file.
4. Activate a new version.

### 2. Configure the purge ACL

Edit the `purge_acl` ACL inside `fastly.vcl` (or define it via
`terraform`) and add the IPs of the origin server(s) so that
`POST /api/v1/edge/invalidate` can issue purges.

### 3. Validate

```bash
curl -i https://siskelbot.example.com/health/live
# X-Edge: fastly
# X-Edge-Cache: BYPASS
# {"status":"ok","edge":"fastly"}

curl -i https://siskelbot.example.com/api/v1/recipes?workspace=default
# First request:  X-Edge-Cache: MISS
# Second request: X-Edge-Cache: HIT
```

## Cache invalidation

The origin exposes an admin-only invalidation endpoint:

```
POST /api/v1/edge/invalidate
Authorization: Bearer $ADMIN_API_KEY
Content-Type: application/json

{
  "paths":    ["/config", "/api/v1/recipes"],
  "patterns": ["recipes-default"]
}
```

Behaviour:

- `paths` are absolute path strings — purged individually.
- `patterns` are surrogate-key / cache-tag strings — used for "purge
  everything tagged X" semantics.
- Either field may be omitted, but not both.

The handler delegates to `lib/edge-cache.js`, which selects the
provider via env:

| Env | Value |
|-----|-------|
| `EDGE_PROVIDER` | `cloudflare`, `fastly`, or `none` (default: auto-detected from credentials) |
| `CLOUDFLARE_API_TOKEN` | API token with `Cache Purge` permission |
| `CLOUDFLARE_ZONE_ID` | Zone ID for the cached hostname |
| `CLOUDFLARE_HOSTNAME` | Hostname used to build absolute URLs |
| `FASTLY_API_TOKEN` | API token with purge permission |
| `FASTLY_SERVICE_ID` | Fastly service ID |
| `FASTLY_HOSTNAME` | Hostname used for per-path PURGE requests |

When `EDGE_PROVIDER=none` (or no credentials are configured), the
endpoint is a no-op and returns `200 OK` without contacting any
provider — useful for development and CI.

A typical post-deploy hook from your CI pipeline:

```bash
curl -X POST "$SISKELBOT_URL/api/v1/edge/invalidate" \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"paths":["/config","/api/docs/openapi.json"]}'
```

## Testing edge cache hits

```bash
# 1. Cold cache — first request should be a MISS
curl -s -o /dev/null -D - https://siskelbot.example.com/config | grep -i x-edge

# 2. Warm cache — within 30s the second should be a HIT
curl -s -o /dev/null -D - https://siskelbot.example.com/config | grep -i x-edge

# 3. Authenticated — should always BYPASS
curl -s -o /dev/null -D - \
  -H "Authorization: Bearer $API_KEY" \
  https://siskelbot.example.com/config | grep -i x-edge

# 4. Purge — invalidate then re-fetch
curl -s -X POST https://siskelbot.example.com/api/v1/edge/invalidate \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"paths":["/config"]}'
curl -s -o /dev/null -D - https://siskelbot.example.com/config | grep -i x-edge
```

## Monitoring edge performance

- **Cloudflare:** the Workers dashboard shows requests, errors, CPU
  time, and cache HIT/MISS ratio. For long-term retention, add an
  `analytics_engine_datasets` binding (commented out in
  `wrangler.toml`) and write one row per request.
- **Fastly:** use the Fastly real-time analytics stream and the
  `Hits`, `Miss`, `Pass` counters; send to your existing observability
  pipeline via the syslog or BigQuery integration.
- **Origin:** the worker / VCL forwards `X-Edge-Cache: MISS|BYPASS`
  on every request that reaches origin, so you can correlate origin
  load with edge behaviour in Grafana.
- **Synthetic checks:** add `/health/live` to `lib/synthetic-monitor.js`
  via the existing `synthetic` route module so you alert when the
  edge layer itself is degraded.

## Security considerations

- **Never cache authenticated responses.** Both the worker and the VCL
  bypass the cache for any request carrying `Authorization`,
  `x-api-key`, or `Cookie`. Do not add new cacheable paths that depend
  on per-user state.
- **Never cache mutating methods.** The worker only matches `GET`/`HEAD`;
  the VCL `pass`es everything else. Even idempotent `POST`s like search
  are intentionally left uncached because they can carry bodies.
- **Origin secrets.** Keep `ADMIN_API_KEY`, `CLOUDFLARE_API_TOKEN`, and
  `FASTLY_API_TOKEN` only on the origin — the worker should never see
  them. The worker forwards request headers verbatim *minus* hop-by-hop
  headers, so do not embed any secrets in worker `vars`.
- **Purge ACL.** The Fastly `purge_acl` must contain only your origin's
  outbound IPs. The Cloudflare token should be scoped to the single
  zone and `Cache Purge` permission only.
- **Stale responses on origin failure.** `stale_if_error` will keep
  serving cached responses for up to 10 minutes after the origin starts
  returning 5xx. This is desirable for read-only paths but means a bad
  deploy can be masked — your alerting must look at origin SLIs as
  well as edge SLIs.
- **Cache poisoning.** The cache key is normalised to include only the
  configured `vary` query params, in sorted order, to avoid attackers
  inflating cache keys with junk parameters. New cacheable paths must
  declare their `vary` set explicitly.

## Related files

- `edge/cloudflare/worker.js` — Cloudflare Workers script
- `edge/cloudflare/wrangler.toml` — Wrangler configuration
- `edge/fastly/fastly.vcl` — Fastly VCL script
- `routes/edge-cache.js` — origin admin endpoint
- `lib/edge-cache.js` — Cloudflare/Fastly purge client
- `tests/edge-cache.test.js` — unit tests
