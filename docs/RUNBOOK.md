# SiskelBot Runbook

Operations guide for the SiskelBot streaming assistant: common failures, environment checklist, backend verification, and troubleshooting.

## Phase 28: Embeddings API & Semantic Search

Embedding-based retrieval for RAG. Uses OpenAI `text-embedding-3-small` (1536 dims) when `OPENAI_API_KEY` is set.

### API

| Endpoint | Method | Description |
|----------|--------|--------------|
| `POST /api/embeddings` | POST | Embed text(s). Body: `{ text: string }` or `{ texts: string[] }`. Returns `{ embedding: number[] }` or `{ embeddings: number[][] }`. |
| `GET /api/knowledge/search?q=...&semantic=1` | GET | Semantic search over indexed docs with embeddings. Add `semantic=1` to use embedding similarity instead of keyword match. |

### Env vars

Uses existing `OPENAI_API_KEY`. No new vars needed.

### Behavior

- **503 EMBEDDINGS_UNAVAILABLE:** Returned when `OPENAI_API_KEY` is not set. Hint suggests setting the key.
- **400 INVALID_BODY:** When body has neither `text` nor `texts`, or both empty.
- **Rate limit:** 30/min per IP (same or stricter than knowledge indexing). Configurable via `EMBEDDINGS_RATE_LIMIT_MAX`.

### Knowledge store

- **Indexing:** `POST /api/knowledge/index` accepts optional `computeEmbedding: true`. When set and `OPENAI_API_KEY` is available, embeddings are computed and stored for semantic search.
- **Semantic search:** Only docs with stored embeddings are searched. Docs without embeddings are skipped. Re-index with `computeEmbedding: true` to enable semantic search for existing docs.
- **Keyword search:** Remains default; additive. Use `?semantic=1` for embedding-based search.

### Client

- **Context panel:** Toggle "Use semantic search" — when on with "Use RAG", RAG uses semantic search instead of keyword.
- **Knowledge panel:** Toggle "Store embeddings" — when on, new indexing requests include embeddings for semantic search.

### Troubleshooting

- **503 on /api/embeddings:** Set `OPENAI_API_KEY` in environment.
- **Empty semantic search results:** Ensure docs were indexed with `computeEmbedding: true`. Check that `OPENAI_API_KEY` was set when indexing.

## Phase 23: API Versioning & Deprecation

### Versioned routes

Stable endpoints use the `/api/v1/` prefix. Legacy `/api/*` routes remain supported but return header `X-API-Deprecated: use /api/v1/`. Migrate to `/api/v1/` when convenient.

| Legacy path | Versioned path |
|-------------|----------------|
| `/api/context` | `/api/v1/context` |
| `/api/recipes` | `/api/v1/recipes` |
| `/api/conversations` | `/api/v1/conversations` |
| `/api/workspaces` | `/api/v1/workspaces` |
| `/api/usage/summary` | `/api/v1/usage/summary` |
| `/api/analytics/dashboard` | `/api/v1/analytics/dashboard` |
| `/api/webhooks` | `/api/v1/webhooks` |
| `/api/schedules` | `/api/v1/schedules` |
| `/api/plugins/actions` | `/api/v1/plugins/actions` |
| `/api/execute-step` | `/api/v1/execute-step` |
| … | … |

### Chat endpoint

`/v1/chat/completions` (OpenAI-compatible) is **not** versioned; it stays as-is per OpenAI spec.

### Deprecation timeline

- **Now:** Legacy `/api/*` works with `X-API-Deprecated` header.
- **Future:** A later phase may remove legacy routes; timeline TBD. Check release notes before upgrades.

### Public API docs

- **Swagger UI:** `GET /api/docs` or `GET /docs` (redirects to `/api/docs`)
- **OpenAPI spec:** `GET /api/docs/openapi.json` (JSON)
- **Source:** `docs/openapi.yaml` (YAML), `lib/openapi-spec.js` (JS export for serving)

### API key scopes (future)

`USER_API_KEYS` may support scope suffixes (e.g. `key1:user1:read,write`) for granular permissions. Not implemented in Phase 23.

## Phase 24: Backup & Restore

Backup and restore workspace data (context, recipes, conversations, usage, webhooks, schedules, oauth-users) as ZIP archives.

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /api/backup` | POST | Create backup (zips `data/` to `backups/YYYY-MM-DD_HH-mm-ss.zip`) |
| `GET /api/backup` | GET | List backups (newest first) |
| `POST /api/backup/restore/:id` | POST | Restore from backup by id |
| `GET /api/backup/cron` | GET | Vercel cron: create daily backup. Requires `?secret=` or `Authorization: Bearer` with BACKUP_ADMIN_KEY or CRON_SECRET. |

### Auth

Backup/restore requires one of:

- `ADMIN_API_KEY` or `BACKUP_ADMIN_KEY` via `Authorization: Bearer` or `x-api-key` / `x-backup-admin-key`
- User in `QUOTA_ADMIN_USER_IDS` when auth is configured (session or user API key)
- When auth not configured and no admin key: allowed (local dev)

### Env vars

| Variable | Default | Notes |
|----------|---------|-------|
| `BACKUP_ADMIN_KEY` | — | Protects backup API and cron. Use with `?secret=` for cron. |
| `BACKUP_MAX_RETAINED` | 7 | Max backup files to retain (oldest pruned) |

### Vercel cron

Add to `vercel.json` crons for daily backup:

```json
{ "crons": [{ "path": "/api/backup/cron", "schedule": "0 2 * * *" }] }
```

Set `BACKUP_ADMIN_KEY` in Vercel env vars. Vercel Cron passes it via `Authorization: Bearer` or configure `?secret=` in the cron config.

### Client

Settings → Backup & Restore: Create backup, list backups, Restore for each.

## Phase 25: Admin Dashboard

Server-side admin UI for users, workspaces, quotas, and system health. Available at `GET /admin`.

### Auth

Admin routes require one of:

- `ADMIN_API_KEY` via `Authorization: Bearer <key>` or `x-admin-api-key` header
- For `GET /api/admin/summary`: `?key=<ADMIN_API_KEY>` in query (browser convenience)
- User in `QUOTA_ADMIN_USER_IDS` via OAuth session

Returns 401 when not admin.

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /admin` | GET | Serves admin dashboard HTML (client/admin.html) |
| `GET /api/admin/summary` | GET | Aggregated dashboard data: users, workspaces, usage, quota, health, audit log |
| `POST /api/admin/quotas/override` | POST | Body: `{ workspace, limit }`. Set workspace quota override (limit in tokens). `limit: null` clears. |

### Env vars

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_API_KEY` | — | Protects admin routes. Set with `QUOTA_ADMIN_USER_IDS` for OAuth-based admin. |

### Dashboard sections

- **Users:** From `data/users/`, `oauth-users.json`, `users.json`
- **Workspaces:** Per-user workspaces with token usage and quota
- **Usage:** 7-day summary (requests, tokens)
- **Quota status:** Configured or not; per-workspace overrides
- **System health:** Backend reachability, integrations (GitHub, Vercel), scheduler
- **Audit log:** Recent entries from `data/execution-audit.json`

### Client

Open `/admin` in browser. Enter `ADMIN_API_KEY` if not logged in as admin user. Override quota per workspace via Set/Clear.

## Phase 28: Embeddings API & Semantic Search

Embeddings and semantic search enable RAG over knowledge using OpenAI `text-embedding-3-small` (1536 dims).

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /api/embeddings` | POST | Body `{ text: string }` or `{ texts: string[] }`. Returns `{ embedding: number[] }` or `{ embeddings: number[][] }`. Uses `text-embedding-3-small`. |
| `GET /api/knowledge/search?semantic=1` | GET | Same as keyword search; `semantic=1` uses embedding-based nearest-neighbor search over docs with stored embeddings. |
| `POST /api/knowledge/index` | POST | Add `computeEmbedding: true` to optionally compute and store embeddings when indexing. |

### Behavior

- **Embeddings:** Requires `OPENAI_API_KEY`. Returns 503 with hint when not set. Rate limit: 30/min per IP (same or stricter than knowledge indexing).
- **Semantic search:** When `?semantic=1`, embeds the query and returns nearest docs by cosine similarity. Only searches docs that have embeddings. Falls back to empty if none.
- **Keyword search:** Default. Unchanged from Phase 5; substring match.

### Env vars

Uses existing `OPENAI_API_KEY`; no new vars. Optional `EMBEDDINGS_RATE_LIMIT_MAX` (default 30).

### Client

- **Context panel:** "Use semantic search" toggle. When on with RAG, uses embedding-based search instead of keyword.
- **Knowledge panel:** "Store embeddings" checkbox. When on, new index calls include `computeEmbedding: true`.

### Troubleshooting

- **503 EMBEDDINGS_UNAVAILABLE:** Set `OPENAI_API_KEY` in environment.
- **Empty semantic results:** Ensure docs were indexed with `computeEmbedding: true`. Re-index if needed.

## Environment checklist

Before deployment or after configuration changes, verify:

| Variable | Required when | Notes |
|----------|----------------|-------|
| `BACKEND` | Always | `ollama`, `vllm`, or `openai` |
| `OLLAMA_URL` | `BACKEND=ollama` | Default: `http://localhost:11434` |
| `VLLM_URL` | `BACKEND=vllm` | Default: `http://localhost:8000` |
| `OPENAI_API_KEY` | `BACKEND=openai` | Required for OpenAI backend |
| `API_KEY` | Production | Protects `/v1/chat/completions`; strongly recommended for production |
| `PORT` | Self-hosted | Default: `3000` |
| `RATE_LIMIT_WINDOW_MS` | Optional | Default: 60000 ms |
| `RATE_LIMIT_MAX` | Optional | Default: 60 requests per window per IP |
| `RATE_LIMIT_MAX_PER_USER` | Phase 21 | Per-user limit when auth configured. Default: RATE_LIMIT_MAX |
| `QUOTA_TOKENS_PER_WORKSPACE` | Phase 21 | Tokens per workspace per period. When unset, no quota enforcement. |
| `QUOTA_WORKSPACE_PERIOD_DAYS` | Phase 21 | Quota period in days. Default: 30 |
| `QUOTA_ADMIN_USER_IDS` | Phase 21 | Comma-separated userIds that bypass quota |
| `ALLOW_RECIPE_STEP_EXECUTION` | Recipe execution | Set to `1` to enable server-side step execution (build, deploy). Default: off. See Phase 9 section. |
| `VERCEL_TOKEN` | Deploy action | Required for `deploy` steps targeting Vercel |
| `PROJECT_DIR` | Build action | Optional; working directory for `build` steps. Default: `process.cwd()` |
| `USAGE_ALERT_TOKENS` | Phase 13 | Optional; when total tokens in rolling window exceeds this, response includes `X-Usage-Alert: 1` and server logs warning. |
| `USER_API_KEYS` | Phase 14 | Optional; `key1:user1,key2:user2` — enables user auth. When set, storage and workspaces require `Authorization: Bearer <key>` or `x-user-api-key`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Phase 19 | Optional; OAuth app credentials for GitHub sign-in. When set with SESSION_SECRET, enables "Sign in with GitHub". |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Phase 19 | Optional; OAuth client credentials for Google sign-in. When set with SESSION_SECRET, enables "Sign in with Google". |
| `SESSION_SECRET` | Phase 19 | Required when OAuth is configured. Long random string for session cookie signing. |
| `BASE_URL` | Phase 19 | For production OAuth callbacks. Full origin (e.g. `https://app.example.com`). Default in dev: `http://localhost:PORT`. |
| `ANALYTICS_COST_PER_1K_INPUT` | Phase 18 | Optional; $ per 1K input tokens for OpenAI cost estimation. Default: 0.002. |
| `ANALYTICS_COST_PER_1K_OUTPUT` | Phase 18 | Optional; $ per 1K output tokens for OpenAI cost estimation. Default: 0.006. |

Never commit secrets to code. Use environment variables or your platform’s secrets manager (e.g. Vercel env vars).

## How to verify each backend

### Ollama

1. Ensure Ollama is installed and running: `ollama serve`
2. Pull a model: `ollama pull llama3.2`
3. Hit health: `curl http://localhost:3000/health` (or `http://YOUR_HOST/health`)
4. Expected: `reachable: true`, `latencyMs` populated

### vLLM

1. Start vLLM: `vllm serve meta-llama/Llama-3-8B-Instruct --max-model-len 4096`
2. Check vLLM directly: `curl http://localhost:8000/v1/models`
3. Hit proxy health: `curl http://localhost:3000/health`
4. Expected: `reachable: true` when vLLM is up

### OpenAI

1. Set `OPENAI_API_KEY` in environment
2. Set `BACKEND=openai`
3. Hit health: `curl http://localhost:3000/health` (with API key if `API_KEY` is set)
4. Expected: `reachable: true` when the key is valid and API is reachable

## Common failures and error codes

API errors return `{ error, code, hint }`. Use `code` for machine-readable handling.

| Code | HTTP | Cause | Mitigation |
|------|------|-------|------------|
| `AUTH_REQUIRED` | 401 | Missing or invalid API key | Provide `Authorization: Bearer <key>` or `x-api-key` header |
| `RATE_LIMITED` | 429 | Too many requests | Wait, or increase `RATE_LIMIT_MAX` |
| `BACKEND_UNREACHABLE` | 502/503 | Backend down, network error, or invalid config | See troubleshooting below |
| `BACKEND_ERROR` | varies | Backend returned non-2xx | Inspect `error` and `hint`; check backend logs |
| `EXECUTION_DISABLED` | 503 | Recipe step execution not enabled on server | Set `ALLOW_RECIPE_STEP_EXECUTION=1` |
| `EXECUTION_NOT_ALLOWED` | 403 | Client toggle off or plan not approved | Enable "Allow recipe step execution" in Settings; confirm if plan requires approval |
| `AUTH_INVALID` | 401 | Invalid user API key (Phase 14) | Check User API key in Settings; ensure it matches USER_API_KEYS or users.json |
| `QUOTA_EXCEEDED` | 429 | Workspace token quota exceeded (Phase 21) | Wait for period reset, use a different workspace, or contact admin |

## Troubleshooting

### `/health` returns 503 or `reachable: false`

- **Ollama**: Ensure `ollama serve` is running. Check `OLLAMA_URL` points to the correct host.
- **vLLM**: Ensure vLLM is running and `VLLM_URL` is correct. vLLM may take time to load models.
- **OpenAI**: Verify `OPENAI_API_KEY` is set and valid. Check network/firewall to `api.openai.com`.

### Chat completions return 502

- Backend is unreachable from the proxy (e.g. wrong URL, backend not running).
- Use `/health` to confirm backend status. See “How to verify each backend” above.

### 401 Unauthorized

- **Deployment API key:** Deployment has `API_KEY` set. Clients must send the key via `Authorization: Bearer <key>` or `x-api-key`. For the web UI, enter the key in Settings → Deployment API key.
- **User API key (Phase 14):** When `USER_API_KEYS` is set, storage and workspaces require a valid user key via `Authorization: Bearer <key>` or `x-user-api-key`. Enter the key in Settings → User API key.

### 429 Too many requests

- **Rate limit:** Default 60 requests per minute per IP; when auth configured, per-user limit applies (RATE_LIMIT_MAX_PER_USER).
- Adjust `RATE_LIMIT_MAX`, `RATE_LIMIT_MAX_PER_USER`, or `RATE_LIMIT_WINDOW_MS` in environment if needed.

### 429 Workspace token quota exceeded (QUOTA_EXCEEDED)

- Per-workspace token quota is enforced when `QUOTA_TOKENS_PER_WORKSPACE` is set.
- Quota resets at period end (QUOTA_WORKSPACE_PERIOD_DAYS). Use a different workspace or wait.
- Admin users (QUOTA_ADMIN_USER_IDS) bypass quota.

### Health cache

- `/health` caches results for 5 seconds to avoid hammering backends.
- Force refresh: `GET /health?refresh=1`

## Health endpoint reference

`GET /health` returns:

```json
{
  "backend": "ollama",
  "reachable": true,
  "latencyMs": 12,
  "lastChecked": "2025-03-18T12:00:00.000Z",
  "backends": {
    "ollama": { "reachable": true, "latencyMs": 12 },
    "vllm": { "reachable": false, "latencyMs": 3002, "error": "..." }
  }
}
```

- `backend`: Active backend (from `BACKEND` env).
- `reachable`: Whether the active backend is reachable.
- `latencyMs`: Latency to active backend (ms).
- `lastChecked`: ISO timestamp of last check.
- `backends`: Per-backend status for configured backends.
- Optional `cached: true` when serving from 5s cache.

## Logs

Structured logs are emitted as JSON:

```json
{"timestamp":"...","requestId":"...","method":"POST","path":"/v1/chat/completions","status":200,"durationMs":150}
```

Search for `requestId` to trace a specific request across logs.

## Phase 13: Observability & Cost Control

Token usage is tracked for each streaming chat completion. Records are stored in `data/usage.json` (gitignored) and aggregated for the Usage panel in the client.

### Token tracking

- **Input tokens:** Estimated from request messages (chars ÷ 4) or from OpenAI `usage.prompt_tokens` when available.
- **Output tokens:** Estimated from streamed content length (chars ÷ 4) or from OpenAI `usage.completion_tokens` when available.
- **Per-request record:** `{ timestamp, model, inputTokens, outputTokens, backend, workspace?, userId? }`

### API

**`GET /api/usage/summary?days=7`**

- **Query:** `days` (1–90, default 7)
- **Response:** `{ totalRequests, totalInputTokens, totalOutputTokens, totalTokens, byModel, byDay, days }`
- **Rate limit:** 30 requests/minute per IP

### Budget alerts

Set `USAGE_ALERT_TOKENS` to a number (e.g. `1000000`). When total tokens in the rolling window (all stored records) reaches or exceeds this:

- Responses include `X-Usage-Alert: 1` header
- Server logs: `[usage] Budget alert: N tokens >= M`

Use this header or logs to trigger monitoring, notifications, or cost controls.

### Data

- **Path:** `data/usage.json`
- **Schema:** `{ _version: 1, records: [{ timestamp, model, inputTokens, outputTokens, backend, workspace?, userId? }, ...] }`
- **Retention:** Rolling window of last 100,000 entries
- **Security:** `data/*.json` is gitignored. Ensure `data/` is not exposed on deployments.

## Phase 18: Conversation Analytics & Insights

The analytics dashboard extends usage tracking with cost estimation, per-workspace breakdown, and export.

### Env vars

| Variable | Default | Notes |
|----------|---------|-------|
| `ANALYTICS_COST_PER_1K_INPUT` | 0.002 | $ per 1K input tokens (OpenAI gpt-4o-mini approx) |
| `ANALYTICS_COST_PER_1K_OUTPUT` | 0.006 | $ per 1K output tokens |
| Ollama/vLLM | — | Treated as local (cost $0) |

### API

**`GET /api/analytics/dashboard?days=7&workspace=`**

- **Query:** `days` (1–90, default 7), `workspace` (optional filter)
- **Response:** `{ totalRequests, totalTokens, totalCost, byModel, byDay, byWorkspace?, conversationStats, topModels, modelComparison? }`
- **Auth:** When `USER_API_KEYS` configured, requires user auth; scoped by userId
- **Rate limit:** 30 requests/minute

**`GET /api/analytics/export?format=csv|json&days=30&workspace=`**

- **Query:** `format` (csv or json, default json), `days` (1–90, default 30), `workspace` (optional)
- **Response:** CSV download or JSON download with usage records and summary
- **Auth:** Same as dashboard
- **Rate limit:** 30 requests/minute

### Client

Usage panel (header) shows: requests, tokens, cost estimate, per-model breakdown, model A/B comparison when multiple models used, and Export CSV/JSON links.

### Cost estimation

- **OpenAI:** Uses `ANALYTICS_COST_PER_1K_INPUT` and `ANALYTICS_COST_PER_1K_OUTPUT`.
- **Ollama/vLLM:** Shown as "local"; cost $0.

## Phase 9: Recipe Execution & Automation Hooks

Recipe execution allows task plan steps to run on the server (e.g. `build`, `deploy`). Execution is **opt-in** and **double-gated**: both a client Settings toggle and a server env var must be enabled.

### Safety model

1. **Client toggle (default: off):** Settings → "Allow recipe step execution". Stored in `localStorage`. When off, Execute only copies the plan to clipboard.
2. **Server gate:** `ALLOW_RECIPE_STEP_EXECUTION=1` must be set. When unset, `POST /api/execute-step` returns 503.
3. **Approval:** Plans with `requiresApproval: true` require user confirmation before execution.
4. **Audit log:** All executed steps are appended to `data/execution-audit.json` with `{ timestamp, action, payload, ok, error? }`.

### Supported actions

| Action | Description | Payload / requirements |
|--------|-------------|------------------------|
| `build` | Run `npm run build` or `payload.command` | `payload.command`: must match `npm run <script>`. `payload.cwd`: project dir (optional). |
| `deploy` | Trigger Vercel deployment | `payload.deployHookUrl`: Deploy Hook URL, or `payload.project` with `VERCEL_TOKEN`. |
| `copy` | No-op server-side; client performs clipboard copy | Logged for audit only. |

### API

**`POST /api/execute-step`**

- **Body:** `{ step: { action, payload? }, allowExecution: true }`
- **Response:** `{ ok, stdout?, stderr? }` or `{ ok: false, error }`
- **Rate limit:** 30 requests/minute per IP
- **Auth:** Uses `apiKeyAuth` when `API_KEY` is set (same as chat completions)

### Audit log

- **Path:** `data/execution-audit.json`
- **Schema:** `[{ timestamp, action, payload, ok, error? }, ...]`
- **Retention:** Last 1000 entries
- **Security:** Ensure `data/` is not exposed to the web. On Vercel, use serverless-only paths or external storage for audit persistence.

### Troubleshooting

- **503 EXECUTION_DISABLED:** Set `ALLOW_RECIPE_STEP_EXECUTION=1` in the environment.
- **403 EXECUTION_NOT_ALLOWED:** Enable "Allow recipe step execution" in Settings.

## Phase 16: Scheduled & Automated Recipes

Recipe schedules let you run recipes at specified times (cron format). Stored in `data/schedules.json`.

### Env vars

| Variable | Required | Notes |
|----------|----------|-------|
| `ENABLE_SCHEDULED_RECIPES` | For in-process scheduler | Set to `1` to enable. Local/node only; starts node-cron. |
| `CRON_SECRET` | For Vercel cron route | Optional; protects `GET /api/cron`. Pass via `Authorization: Bearer <secret>` or `?secret=`. |
| `ALLOW_RECIPE_STEP_EXECUTION` | For execution | Must be `1` or scheduled runs are skipped. |

### Cron format

Standard 5-field: `minute hour day-of-month month day-of-week`.

Examples:

- `0 9 * * 1-5` — 9am weekdays
- `0 9 * * *` — 9am daily
- `0 0 * * 1` — midnight Monday
- `*/15 * * * *` — every 15 minutes

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/schedules` | GET | List scheduled recipes (`?workspace=` optional) |
| `POST /api/schedules` | POST | Add/update schedule `{ recipeId, cron, timezone?, enabled? }` |
| `DELETE /api/schedules/:recipeId` | DELETE | Remove schedule |
| `POST /api/schedules/run-now/:recipeId` | POST | Manual trigger (uses apiKeyAuth) |
| `GET /api/cron` | GET | Vercel cron: run due jobs. Requires `CRON_SECRET` when set. |

### Local vs Vercel

- **Local:** Set `ENABLE_SCHEDULED_RECIPES=1`. node-cron runs in-process; each schedule fires at its cron time.
- **Vercel:** Use `vercel.json` crons to hit `GET /api/cron` every minute. Set `CRON_SECRET` and configure Vercel Cron to send it. `runDueJobsVercel` runs only recipes whose cron matches the current minute.

### Audit log

Scheduled runs append to `data/execution-audit.json` with `source: "scheduled"`.

### Troubleshooting

- **Schedules not running (local):** Set `ENABLE_SCHEDULED_RECIPES=1` and `ALLOW_RECIPE_STEP_EXECUTION=1`. Restart server.
- **Schedules not running (Vercel):** Ensure `CRON_SECRET` is set and Vercel Cron passes it. Check Vercel logs for `/api/cron` requests.
- **Invalid cron:** Use 5-field format. Test with presets in the Schedule modal.

## PWA & Offline (Phase 20)

SiskelBot is a Progressive Web App with offline support.

### Install prompt

- **Criteria:** HTTPS, valid manifest, registered service worker, user engagement (e.g. not previously installed).
- **Banner:** Shown when `beforeinstallprompt` fires and user has not dismissed (`siskelbot-install-dismissed` in localStorage).
- **Dismissal:** User can dismiss; state stored in localStorage so banner does not reappear.

### Offline behavior

| State | Behavior |
|-------|----------|
| **Online** | Normal operation. Messages and conversations cached to service worker on persist. |
| **Offline** | App shell loads from cache. Offline indicator shown in header. Send disabled. Cached messages from localStorage and SW cache available for reading. |

### Service worker caches

- **App shell (`siskelbot-v1`):** index.html, manifest, icons, CDN scripts (DOMPurify, marked).
- **Conversations (`siskelbot-convos-v1`):** Recent conversation data; populated via `postMessage({ type: 'CACHE_CONVOS', payload })` from the page.

### Testing offline

1. DevTools → Application → Service Workers → Offline.
2. Reload; app should load; header shows "Offline".
3. Cached conversations and messages remain readable; send is disabled.

### Troubleshooting

- **Install banner never appears:** Ensure HTTPS, manifest linked, SW registered. Some browsers require prior engagement (e.g. 30 seconds on site).
- **Offline indicator missing:** Check `navigator.onLine` and `online`/`offline` events in console.

## Phase 19: OAuth & SSO

OAuth (GitHub, Google) provides browser-based sign-in. When configured with `SESSION_SECRET`, users can "Sign in with GitHub" or "Sign in with Google" instead of (or alongside) API key auth.

### Env vars

| Variable | Required | Notes |
|----------|----------|-------|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | For GitHub | Create OAuth App at GitHub → Settings → Developer settings → OAuth Apps |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For Google | Create OAuth 2.0 client at Google Cloud Console → APIs & Services → Credentials |
| `SESSION_SECRET` | OAuth | Long random string. Required for session persistence. |
| `BASE_URL` | Production | Full origin for OAuth callbacks, e.g. `https://app.example.com` |

### Auth flow

- `GET /auth/github` — redirect to GitHub OAuth
- `GET /auth/github/callback` — handle callback, create session, redirect to /
- `GET /auth/google`, `GET /auth/google/callback` — same for Google
- `GET /auth/logout` — destroy session, redirect to /
- `GET /auth/me` — returns `{ userId, provider }` if authenticated

### Session vs API key

- Session (cookie) takes precedence when both session and API key are present.
- API key auth still works for programmatic access (scripts, API clients).
- When no OAuth env is set, behavior is backward compatible (API key or anonymous only).

### Provider setup

**GitHub:** Add callback URL `{BASE_URL}/auth/github/callback` in OAuth App settings.

**Google:** Add authorized redirect URI `{BASE_URL}/auth/google/callback` in OAuth client.

## Phase 14: User Authentication & Workspaces

When `USER_API_KEYS` (or `data/users.json`) or OAuth is configured, storage and workspace endpoints require authentication.

### Auth flow

1. **No auth:** Omit `USER_API_KEYS`. Server treats all requests as `anonymous` user with `default` workspace. Data paths: `data/users/anonymous/workspaces/default/`.
2. **With auth:** Set `USER_API_KEYS=key1:user1,key2:user2` or create `data/users.json`, or configure OAuth (Phase 19). Clients send `Authorization: Bearer <key>` or `x-user-api-key` header, or sign in via OAuth (session cookie). Server sets `req.userId` and scopes storage by user.

### API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/workspaces` | Required when auth configured | List workspaces for user |
| `POST /api/workspaces` | Required when auth configured | Create workspace `{ name }` |
| Storage routes (`/api/context`, `/api/recipes`, `/api/conversations`) | Required when auth configured | Accept `?workspace=X` or body `workspace`. Data scoped by `userId` + `workspaceId`. |

### Data layout

- **Paths:** `data/users/{userId}/workspaces/{workspaceId}/context.json` (and recipes, conversations)
- **Workspace metadata:** `data/users/{userId}/workspaces.json` — `{ items: [{ id, name, userId, createdAt }] }`
- **Migration:** Legacy `data/context.json` etc. is migrated to `data/users/anonymous/workspaces/default/` on first access.

### Troubleshooting

- **401 AUTH_REQUIRED:** Provide `Authorization: Bearer <key>` or `x-user-api-key` header.
- **401 AUTH_INVALID:** Key not in `USER_API_KEYS` or `users.json`. Check key and server config.
- **Build fails:** Ensure `payload.command` is `npm run <script>` (e.g. `npm run build`). Check `PROJECT_DIR` or `payload.cwd` points to a valid project.
- **Deploy fails:** For Vercel, set `VERCEL_TOKEN`. Use `payload.deployHookUrl` for Deploy Hooks, or `payload.project` with a Git-linked project.

## Phase 21: Per-User & Per-Workspace Quotas

### Per-user rate limit

When `USER_API_KEYS` is configured, chat is rate-limited by `userId` instead of IP. Each authenticated user gets up to `RATE_LIMIT_MAX_PER_USER` requests per window (default: same as `RATE_LIMIT_MAX`). Anonymous (no auth configured) uses IP-based limit.

### Per-workspace token quota

Set `QUOTA_TOKENS_PER_WORKSPACE` (e.g. `100000`) to cap tokens per workspace per period. When exceeded, chat returns 429 with `code: "QUOTA_EXCEEDED"` and `X-Quota-Remaining: 0`.

- **Period:** `QUOTA_WORKSPACE_PERIOD_DAYS` (default: 30)
- **Admin override:** `QUOTA_ADMIN_USER_IDS=user1,user2` — these users bypass quota
- **Backward compat:** No quota env = no quota enforcement

### Quota headers

`X-Quota-Limit`, `X-Quota-Remaining`, `X-Quota-Reset` (Unix timestamp) on:
- Chat completion responses
- `GET /api/usage/summary?workspace=X`
- `GET /api/analytics/dashboard?workspace=X`

- **401 AUTH_REQUIRED:** Provide `Authorization: Bearer <key>` or `x-user-api-key` header.
- **401 AUTH_INVALID:** Key not in `USER_API_KEYS` or `users.json`. Check key and server config.
- **Build fails:** Ensure `payload.command` is `npm run <script>` (e.g. `npm run build`). Check `PROJECT_DIR` or `payload.cwd` points to a valid project.
- **Deploy fails:** For Vercel, set `VERCEL_TOKEN`. Use `payload.deployHookUrl` for Deploy Hooks, or `payload.project` with a Git-linked project.
