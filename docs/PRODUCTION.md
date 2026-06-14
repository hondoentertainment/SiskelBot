# Production deployment checklist

Use this before pointing real users or partners at a deployment.

## Required

| Item | Env / action |
|------|----------------|
| **API authentication** | `API_KEY` with scopes; verify `GET /config` returns `requiresApiKey: true` |
| **Session secret** | `SESSION_SECRET` when OAuth/SSO is enabled |
| **Durable storage** | One of: `STORAGE_PATH` (mounted volume), `STORAGE_BACKEND=postgres` + `DATABASE_URL`, or `STORAGE_BACKEND=sqlite` on a persistent host |
| **Backend** | `BACKEND` + provider keys (`OPENAI_API_KEY`, etc.) as needed |

On **Vercel serverless**, unset `STORAGE_PATH` uses **ephemeral** `os.tmpdir()` — workspaces, billing, webhooks, and Phase 63 data **will not survive** cold starts. Set `REQUIRE_DURABLE_STORAGE=1` to refuse boot without durable storage.

## Recommended

| Item | Notes |
|------|--------|
| **Admin API** | `ADMIN_API_KEY` for `/api/v1/pr-review/*`, `/api/v1/repo-rag/*`, `/api/v1/test-gen/*` |
| **Strict production auth** | `REQUIRE_PRODUCTION_API_KEY=1` on long-lived VMs (refuses boot without `API_KEY`) |
| **Cron frequency** | `vercel.json` runs `/api/cron` every **5 minutes** — tune if jobs are heavy |
| **Observability** | `OTEL_ENABLED=1` + exporter endpoint; optional `ENABLE_METRICS=1` |
| **Stripe** | Webhook URL + signing secret; durable store for billing events |
| **Smoke secrets** | GitHub `SMOKE_TEST_API_KEY`, `SMOKE_TEST_ADMIN_API_KEY` for weekly production smoke |

## CI gates (mirror locally)

```bash
npm ci
npm run bootstrap:check   # finite boot probe
npm run ci                # lint + tests + coverage
npm run eval:golden
npm run smoke-test:ci     # against running server
```

## Phase 63 billing

Metering writes to `usage.json` (`feature`, `calls`, `model`) and `eval-history` (`suite: phase63`). Create pricing rules with `modelId` matching the feature and `unit: call`:

```bash
# Example: $0.01 per pr-review call (via pricing-engine API or admin tooling)
```

Env limits for repo indexing:

- `REPO_RAG_MAX_FILES` (default 5000)
- `REPO_RAG_MAX_BYTES` (default 52428800)

## Realtime / WebSockets

In-memory signaling requires a **single long-lived instance** or Redis-backed pub/sub. Multi-instance serverless without sticky sessions will break presence/WebRTC unless you add an external realtime tier.

## Branch protection (GitHub)

Require status checks: **lint**, **test**, **Trivy filesystem scan**, **smoke** (on merge to main).

See [docs/PRODUCTION.md](./PRODUCTION.md) and [docs/BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md).
