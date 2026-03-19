# SiskelBot Runbook

Operations guide for the SiskelBot streaming assistant: common failures, environment checklist, backend verification, and troubleshooting.

## Phase 34: Production Hardening

Production readiness: graceful shutdown, security headers, health probes, startup validation, structured logging.

### Graceful shutdown (self-hosted only; not on Vercel)

On `SIGTERM` or `SIGINT`:

1. Stop accepting new connections (`httpServer.close()`)
2. Stop scheduler/cron if `ENABLE_SCHEDULED_RECIPES=1`
3. Close WebSocket server (`/ws`)
4. Wait for in-flight requests (default 10s via `SHUTDOWN_TIMEOUT_MS`)
5. Exit process

### Security headers

Helmet middleware adds: `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`; `Strict-Transport-Security` in production. CSP disabled by default (SPA may use inline scripts).

| Variable | Default | Notes |
|----------|---------|-------|
| `DISABLE_SECURITY_HEADERS` | — | Set to `1` to disable security headers (e.g. dev). |

### Health probes (k8s/container orchestration)

| Endpoint | Response | Description |
|----------|----------|-------------|
| `GET /health/live` | 200 `{ ok: true, status: "alive" }` | Liveness: process is alive. No external deps. |
| `GET /health/ready` | 200 `{ ok: true, status: "ready", backend }` | Readiness: storage accessible, backend reachable. Returns 503 when not ready. |
| `GET /health` | 200 (existing) | Full backend health with backends object, latency. |

On Vercel: probes work; graceful shutdown and WebSocket do not apply.

### Startup config validation

- **Required (production only):** `OPENAI_API_KEY` when `BACKEND=openai`. Exits with clear error if missing.
- **Optional warnings:** `SESSION_SECRET` when OAuth configured; `VERCEL_TOKEN` when recipe execution enabled.

### Structured logging

- **X-Request-Id:** All responses include `X-Request-Id` (from header or generated).
- **Log format:** JSON when `NODE_ENV=production`; human-readable in dev.

### Env vars

| Variable | Notes |
|----------|-------|
| `DISABLE_SECURITY_HEADERS` | Set to `1` to disable helmet (dev). |
| `SHUTDOWN_TIMEOUT_MS` | Graceful shutdown wait (default 10000ms). |

## Phase 35: Content Security Policy (CSP)

CSP header in production when `ENABLE_CSP=1`. Report-only by default to avoid breaking SPA; set `CSP_ENFORCE=1` to enforce after validation.

| Variable | Notes |
|----------|-------|
| `ENABLE_CSP` | Set to `1` in production to add CSP. Requires `NODE_ENV=production`. |
| `CSP_ENFORCE` | Set to `1` to enforce (block violations). Default: report-only. |

Directives allow: `'self'`, `cdn.jsdelivr.net`, `api.openai.com`, `ws:`, `wss:`, `'unsafe-inline'` for scripts/styles (SPA).

## Phase 36: Log Sanitization

All structured log entries are sanitized to redact sensitive values. Keys matching `api_key`, `authorization`, `token`, `password`, `secret`, `cookie`, and similar are replaced with `[REDACTED]` before logging.

No env vars. Applied automatically to request logs and error context.

## Phase 37: Backend Circuit Breaker

After N consecutive backend failures, the proxy returns 503 immediately instead of waiting on the backend. Resets after cooldown.

| Variable | Default | Notes |
|----------|---------|-------|
| `CIRCUIT_BREAKER_FAILURES` | 5 | Consecutive failures before circuit opens |
| `CIRCUIT_BREAKER_COOLDOWN_MS` | 30000 | Cooldown before retry (ms) |

Error code: `CIRCUIT_OPEN` with `503 Service Unavailable`. Retry after cooldown.

## Phase 38: Error Reporting Webhook

When unhandled errors occur (`uncaughtException`, `unhandledRejection`) in production, the server POSTs to `ERROR_REPORT_WEBHOOK_URL`. Payload: `{ message, name, stack, timestamp, source }`.

| Variable | Notes |
|----------|-------|
| `ERROR_REPORT_WEBHOOK_URL` | URL for error webhook (Slack, PagerDuty, etc.). Only active when `NODE_ENV=production`. |

## Phase 39: Deployment Smoke Tests

Post-deploy script verifies health probes and critical endpoints.

- **Run:** `npm run smoke-test` or `node scripts/smoke-test.js [BASE_URL]`
- **CI:** `npm run smoke-test:ci` (uses `--live-only`; skips readiness and chat when backend unavailable)
- **Checks:** `/health/live`, `/health/ready`, `/config`, `/`, optionally `POST /v1/chat/completions`

Set `BASE_URL` for deployed app; defaults to `http://localhost:3000`. Exits 1 on failure.

## Phase 33: Real-Time Sync & Presence

WebSocket-based live notifications. When a notification is created (recipe_executed, schedule_completed, plan_created, etc.), it is pushed to connected clients. Falls back to 30s polling when WebSocket is unavailable. Presence tracks online users per workspace (in-memory, TTL-based).

### API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/ws-token` | GET | Get one-time token for WebSocket. Query: `?workspace=default`. Returns `{ token, url }`. Auth: userAuth (anonymous allowed). |
| `GET /api/workspaces/:id/presence` | GET | List online users in workspace. Returns `{ online: [{ userId, displayName }] }`. Auth: userAuth. Personal workspaces allowed; team requires membership. |

### WebSocket

- **Path:** `/ws`
- **Query:** `token` (from ws-token), `workspace`
- **Auth:** One-time token from `GET /api/ws-token`
- **Messages (server → client):** `{ type: "notification", notification: { id, type, title, body, createdAt, read } }`
- **Messages (client → server):** `{ type: "heartbeat", displayName? }` to refresh presence
- **Typing (optional):** `{ type: "typing", typing: boolean }` broadcasts to other users in workspace

### Client

- Connects to WebSocket on load when visible; uses ws-token for auth.
- On notification message: refreshes list and badge; prepends new items.
- Fallback: 30s polling when WS disconnected or fails.
- Reconnect: exponential backoff (1s → 30s max) on disconnect.
- Workspace change: reconnects with new workspace.

### Env vars

| Variable | Notes |
|----------|-------|
| `BASE_URL` | When set, ws-token URL uses it (wss for https). |
| `WS_HOST` | Fallback host for ws-token URL when BASE_URL not set. |
| `VERCEL` | When `1`, WebSocket server not attached (serverless). Client falls back to polling. |

### Data

- **Presence:** In-memory only. TTL 90s per user. No persistence.
- **Token store:** In-memory. TTL 60s. Cleaned every 30s.

### Troubleshooting

- **WebSocket not connecting:** On Vercel, WS is disabled; use polling.
- **401 on ws-token:** Ensure credentials (cookie or API key) are sent.
- **Notifications not live:** Check WS connection in DevTools; if disconnected, polling runs.

## Phase 29: Multi-Tenant Teams & Collaboration

Team workspaces, invite codes, roles, activity feed. Requires auth (Phase 14).

### Workspace types

| Type | Description |
|------|--------------|
| `personal` | Single user (default; backward compatible) |
| `team` | Shared; members with admin/member/viewer roles |

Existing workspaces without `type` default to `personal`.

### API

| Endpoint | Method | Description |
|----------|--------|--------------|
| `POST /api/workspaces` | POST | Create workspace. Body: `{ name, type?: "personal" \| "team" }`. |
| `POST /api/workspaces/:id/invite` | POST | Generate invite code for team workspace. Body: `{ expiresInHours?, maxUses? }`. Returns `{ code, inviteLink, expiresAt?, maxUses? }`. |
| `POST /api/workspaces/join` | POST | Join team by code. Body: `{ code }`. Returns `{ ok, workspace: { id, name } }`. |
| `GET /api/workspaces/:id/members` | GET | List members (ownerId, members with userId, role). |
| `GET /api/workspaces/:id/activity` | GET | Activity feed. Query: `?limit=50`. Returns `{ items }`. |

### Data

| File | Purpose |
|------|---------|
| `data/workspace-members.json` | workspaceId → { ownerId, members: [{ userId, role }] } |
| `data/team-invites.json` | Invite codes (code, workspaceId, createdBy, usedCount, expiresAt?, maxUses?) |
| `data/workspace-activity.json` | byWorkspace[workspaceId]: [{ timestamp, action, userId, ... }] |

### Roles

- **admin:** Full access; can create invites, manage members.
- **member:** Can add context, run recipes, create invites.
- **viewer:** Read-only (context, recipes, conversations).

### Client

- **Workspace panel:** Create (personal/team), Join (by code), Invite, Members, Activity.
- **Join flow:** `?join=CODE` in URL opens join modal with code prefilled.
- **Team panel:** Shown when team workspace selected; Generate invite, Members list, Activity feed.

### Troubleshooting

- **403 FORBIDDEN on invite:** Admin or member role required.
- **400 JOIN_FAILED:** Invalid or expired code; check team-invites.json.
- **Existing workspaces:** No changes; default to personal.

## Phase 32: Evaluation Harness

Evaluation harness for automated testing of chat and task-planning APIs against defined eval sets.

### Eval set schema

```json
{
  "id": "string",
  "name": "string",
  "description": "optional",
  "cases": [
    {
      "id": "string",
      "prompt": "string",
      "systemPrompt": "optional",
      "target": "chat | task (default: chat)",
      "expectedContains": "substring to find",
      "expectedPattern": "regex string",
      "expectedJson": ["key1", "key2"] | "key"
    }
  ]
}
```

### API

| Endpoint | Method | Description |
|----------|--------|--------------|
| `GET /api/eval/sets` | GET | List available eval sets (from `data/eval-sets/*.json` or `data/eval-sets.json`). Returns `{ sets: [{ id, name }] }`. |
| `POST /api/eval/run` | POST | Run eval set. Body: `{ evalSetId?: string, evalSet?: object, model?: string }`. Returns `{ results, passed, total, durationMs }`. |

### Criteria

- **expectedContains:** Substring must be present in output (case-sensitive).
- **expectedPattern:** Output must match regex.
- **expectedJson:** Parsed JSON (from task API or code block) must have all listed keys.

### Auth

Eval endpoints accept `ADMIN_API_KEY` or `API_KEY` via `Authorization: Bearer <key>` or `x-api-key` / `x-admin-api-key`. When neither key is set (local dev), eval is allowed without auth.

### Rate limit

5 runs per minute per IP for eval endpoints. 429 with `RATE_LIMITED` when exceeded.

### Env vars

| Variable | Notes |
|----------|-------|
| `ADMIN_API_KEY` | Protects eval when set; also accepts `API_KEY` |
| `API_KEY` | Alternative to ADMIN_API_KEY for eval |

### Data

- **Path:** `data/eval-sets/*.json` (per-file) or `data/eval-sets.json` (single file with array/sets)
- **Example:** `data/eval-sets/example.json`

### Client

- **URL:** `GET /eval` — dedicated eval page: select set, run, view results.
- **Admin:** Link from Admin dashboard to `/eval` when available.

### Troubleshooting

- **401 AUTH_REQUIRED:** Set `ADMIN_API_KEY` or `API_KEY` and pass via Bearer or header.
- **429 RATE_LIMITED:** Wait 1 minute before retrying eval run.
- **502 BACKEND_UNREACHABLE:** Ensure Ollama/vLLM/OpenAI backend is running for eval cases that call chat/task API.

## Phase 31: Internationalization (i18n)

UI strings can be shown in multiple languages. Locale files live in `client/locales/`.

### Supported locales

| Code | Language  |
|------|-----------|
| `en` | English   |
| `es` | Spanish   |
| `fr` | French    |
| `de` | German    |

### How it works

- **Locale files:** `client/locales/{lang}.json` — nested key-value structure (e.g. `header.newChat`, `modal.continueChat`).
- **Translation function:** `SiskelI18n.t(key)` returns translated string or key as fallback.
- **Fallback chain:** requested locale → `en` → key.
- **Language detection:** `navigator.language`, then `localStorage` key `siskelbot-locale` override.
- **Locale switcher:** Settings panel → Language dropdown.

### RTL support

For RTL locales (e.g. `ar`), `dir="rtl"` is set on `<html>`. Layout is ready; no RTL locale included in MVP.

### Adding a new locale

1. Copy `client/locales/en.json` to `client/locales/{code}.json`.
2. Translate values (keep keys).
3. Add `{code}` to `SUPPORTED_LOCALES` in `client/i18n.js`.
4. Add option to `#locale-select` in Settings.

### Static UI

Elements with `data-i18n="key"` get their text replaced on init and when locale changes. Use `data-i18n-placeholder`, `data-i18n-title`, `data-i18n-aria-label` for attributes.

### Dynamic strings

## Phase 32: Evaluation Harness

Evaluation harness for SiskelBot: run eval sets against chat/task APIs and check output criteria.

### Eval set schema

Eval sets live in `data/eval-sets/*.json` or a single `data/eval-sets.json`. Schema:

```json
{
  "id": "example",
  "name": "Example Eval Set",
  "description": "Optional",
  "cases": [
    {
      "id": "case-1",
      "prompt": "User prompt text",
      "systemPrompt": "Optional system prompt",
      "target": "chat | task",
      "expectedContains": "substring",
      "expectedPattern": "regex",
      "expectedJson": ["key1", "key2"]
    }
  ]
}
```

- **expectedContains:** Substring must appear in output.
- **expectedPattern:** Regex must match output.
- **expectedJson:** JSON (from task API or parsed from output) must have these keys.

### API

| Endpoint | Method | Description |
|----------|--------|--------------|
| `GET /api/eval/sets` | GET | List available eval sets. Returns `{ sets: [{ id, name }, ...] }`. |
| `POST /api/eval/run` | POST | Run eval. Body: `{ evalSetId?: string, evalSet?: object, model?: string }`. Returns `{ results, passed, total, durationMs }`. |

### Auth

Eval endpoints accept `ADMIN_API_KEY` or `API_KEY` via `Authorization: Bearer <key>` or `x-api-key` / `x-admin-api-key`. When neither is set (local dev), no auth required.

### Rate limit

5 runs per minute per IP for eval. `POST /api/eval/run` is rate limited.

### Client UI

`GET /eval` serves the eval UI: select set, run, view results. Styled like Admin dashboard.

### Env vars

| Variable | Notes |
|----------|-------|
| `ADMIN_API_KEY` | Optional; protects eval when set |
| `API_KEY` | Optional; also accepted for eval |

Use `SiskelI18n.t('key')` or `SiskelI18n.tInterp('key', { name: value })` in JS for strings set at runtime.

## Phase 32: Evaluation Harness

Evaluation harness for running eval sets against chat and task APIs. Used to validate model behavior via criteria (substring, regex, JSON key existence).

### Eval set schema

Eval sets are JSON files in `data/eval-sets/*.json` or a single `data/eval-sets.json`:

```json
{
  "id": "example",
  "name": "Example Eval Set",
  "cases": [
    {
      "id": "greeting",
      "prompt": "Say hello in one word.",
      "systemPrompt": "optional system message",
      "target": "chat",
      "expectedContains": "hello"
    },
    {
      "id": "task-plan",
      "prompt": "Create a plan to water plants.",
      "target": "task",
      "expectedJson": ["type", "name", "steps"]
    }
  ]
}
```

- **target:** `"chat"` (default) or `"task"` — calls `/v1/chat/completions` or `/v1/tasks/plan`.
- **expectedContains:** Substring must appear in output.
- **expectedPattern:** Regex must match output.
- **expectedJson:** Array of keys (or single key) that must exist in parsed JSON.

### API

| Endpoint | Method | Description |
|----------|--------|--------------|
| `GET /api/eval/sets` | GET | List available eval sets (`data/eval-sets/*.json` or `data/eval-sets.json`). Returns `{ sets: [{ id, name }] }`. |
| `POST /api/eval/run` | POST | Run eval. Body: `{ evalSetId?: string, evalSet?: object, model?: string }`. Returns `{ results, passed, total, durationMs }`. |

### Auth

Eval endpoints accept `ADMIN_API_KEY` or `API_KEY` via `Authorization: Bearer <key>` or `x-api-key` / `x-admin-api-key`. When neither key is set (local dev), requests are allowed without auth.

### Rate limit

5 runs per minute per IP for eval endpoints. Returns 429 `RATE_LIMITED` when exceeded.

### Client

`GET /eval` — Dedicated eval UI: select set, run, view results. Requires API key when `ADMIN_API_KEY` or `API_KEY` is set.

### Env vars

Uses existing `ADMIN_API_KEY` and `API_KEY`. No new vars.

### Troubleshooting

- **401 AUTH_REQUIRED:** Provide `ADMIN_API_KEY` or `API_KEY` via Bearer or `x-api-key` header.
- **429 RATE_LIMITED:** Wait before running eval again (5/min).
- **502 BACKEND_UNREACHABLE:** Ensure Ollama/vLLM/OpenAI backend is running for eval runs.

## Phase 29: Multi-Tenant Teams & Collaboration

Team workspaces with invite codes, roles (admin, member, viewer), shared context/recipes/conversations, and activity feed.

### Workspace types

- **personal** (default): Owned by one user; existing workspaces default to personal.
- **team**: Shared workspace; creator is admin; members invited via code.

### API

| Endpoint | Method | Description |
|----------|--------|--------------|
| `POST /api/workspaces` | POST | Create workspace. Body: `{ name, type?: "personal" \| "team" }`. |
| `POST /api/workspaces/:id/invite` | POST | Generate invite code. Body: `{ expiresInHours?, maxUses? }`. Returns `{ code, inviteLink, expiresAt?, maxUses? }`. Requires admin or member role. |
| `POST /api/workspaces/join` | POST | Join by code. Body: `{ code }`. Requires auth. |
| `GET /api/workspaces/:id/members` | GET | List members. Returns `{ ownerId, members: [{ userId, role }] }`. |
| `GET /api/workspaces/:id/activity` | GET | Activity feed. Query: `?limit=50`. Returns `{ items }`. |

### Data

- **workspace-members.json:** `{ items: { [workspaceId]: { ownerId, members: [{ userId, role }] } } }`
- **team-invites.json:** `{ invites: [{ code, workspaceId, createdBy, createdAt, usedCount, expiresAt?, maxUses? }] }`
- **workspace-activity.json:** `{ byWorkspace: { [workspaceId]: [{ timestamp, action, userId, ...meta }] } }`

### Roles

- **admin**: Full access; can create invites, manage members.
- **member**: Can create invites; add/edit context, recipes, conversations.
- **viewer**: Read-only access.

### Activity actions

Logged via `logActivity`: `context_added`, `recipe_added`, `recipe_ran`, `conversation_created`, etc.

### Client

- **Workspace panel:** Create (personal/team), Join (invite code), Generate invite, Members list, Activity feed.
- **Join flow:** URL `?join=CODE` opens join modal with code prefilled.
- **Backward compat:** Existing workspaces remain personal; no breaking changes.

### Troubleshooting

- **403 FORBIDDEN on invite:** User must be admin or member of the team workspace.
- **400 JOIN_FAILED:** Invalid or expired invite code; user may already be a member.

## Phase 29: Multi-Tenant Teams & Collaboration

Team workspaces with invite codes, roles, members, and activity feed.

### Workspace types

| Type | Description |
|------|-------------|
| `personal` | Single-user workspace (default). Existing workspaces default to personal. |
| `team` | Shared workspace with members. Context, recipes, conversations are shared. |

### Roles

- **admin** — Full access; can create invites, manage members.
- **member** — Can add/edit context, run recipes, create invites.
- **viewer** — Read-only access to context, recipes, conversations.

### API

| Endpoint | Method | Description |
|----------|--------|--------------|
| `POST /api/workspaces` | POST | Create workspace. Body: `{ name, type?: "personal" \| "team" }`. Default type: personal. |
| `POST /api/workspaces/:id/invite` | POST | Generate invite code for team workspace. Body: `{ expiresInHours?, maxUses? }`. Returns `{ code, inviteLink, expiresAt?, maxUses? }`. |
| `POST /api/workspaces/join` | POST | Join by invite code. Body: `{ code }`. Returns `{ ok, workspace?: { id, name } }`. |
| `GET /api/workspaces/:id/members` | GET | List workspace members. Returns `{ ownerId, members: [{ userId, role }] }`. |
| `GET /api/workspaces/:id/activity` | GET | Activity feed. Query: `?limit=50`. Returns `{ items }`. |

### Data files

- **workspace-members.json** — `{ items: { [workspaceId]: { ownerId, members } } }`
- **team-invites.json** — `{ invites: [{ code, workspaceId, createdBy, createdAt, usedCount, expiresAt?, maxUses? }] }`
- **workspace-activity.json** — `{ byWorkspace: { [workspaceId]: [{ timestamp, action, userId, ...meta }] } }`

### Activity actions

Logged automatically: `context_added`, `recipe_added`, `conversation_created`, `recipe_ran`.

### Client

- **Workspace panel** (auth required): Create (personal/team), Join by code, Invite, Members, Activity.
- **Join flow:** `?join=CODE` in URL opens join modal with code prefilled.

### Backward compatibility

- Existing workspaces without `type` default to `personal`.
- Personal workspaces behave identically to pre-Phase 29.
- Storage paths unchanged; team workspace data lives in owner's path.

### Troubleshooting

- **403 FORBIDDEN on invite:** Ensure user has admin or member role.
- **Invalid or expired invite:** Code may have reached max uses or expired. Generate a new invite.
- **Team panel not showing:** Ensure workspace has `type: "team"` and user has access.

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

## Phase 30: API Key Scopes & Granular Permissions

API keys can have scopes: `read`, `write`, `admin`, `embed`. Routes enforce scope checks when the request is authenticated via API key. Session/OAuth users have full access (no scope restriction).

### Key formats

| Source | Format | Example |
|--------|--------|---------|
| `USER_API_KEYS` env | `key:userId` or `key:userId:scopes` | `k1:u1:read,write`, `k2:u2:admin` |
| `API_KEY_SCOPES` env | Deployment key scopes (default: `read,write`) | `read,write` |
| `data/api-keys.json` | Admin-managed keys via Admin dashboard | Created with userId and scopes |

Keys without scopes default to `read,write` (backward compatible).

### Scope → routes

| Scope | Routes |
|-------|--------|
| `read` | GET /context, GET /recipes, GET /workspaces, GET /knowledge/search, GET /knowledge/list |
| `write` | POST /v1/chat/completions, POST /context, POST /recipes, PUT/DELETE context/recipes, schedules/run-now |
| `admin` | /api/admin/* |
| `embed` | POST /api/embeddings |

### Admin key management

- **API:** `GET /api/admin/keys`, `POST /api/admin/keys` (body: `{ userId, scopes }`), `DELETE /api/admin/keys/:id`
- **Storage:** `data/api-keys.json` (keys hashed; raw key shown only on creation)
- **Dashboard:** Admin → API Keys section: list (masked), add with userId and scopes, revoke

### Audit

- API key usage logged to `data/api-key-audit.json` (keyId, timestamp, path, method)

### Env vars

| Variable | Notes |
|----------|-------|
| `API_KEY_SCOPES` | Scopes for deployment `API_KEY`. Default: `read,write` |
| `RATE_LIMIT_PER_KEY` | Optional. When set (e.g. 60), per-key rate limit for chat (req/min). |

### Troubleshooting

- **403 SCOPE_REQUIRED:** Key lacks required scope. Check key scopes in USER_API_KEYS or Admin → API Keys.
- **429 RATE_LIMITED (per key):** Set `RATE_LIMIT_PER_KEY` higher or wait for window reset.

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

## Phases 50–54: Storage, streaming, audit, fallback, tracing

| Phase | Env / behavior | Notes |
|-------|----------------|-------|
| **50** | `STORAGE_BACKEND=sqlite` | Optional `better-sqlite3`; DB file `storage-kv.db` under data dir. Default: JSON files. |
| **51** | `STREAM_AGENT_FINAL=1`, `AGENT_STREAM_CHUNK_SIZE` (default 320) | Agent final assistant text split into multiple SSE deltas. |
| **52** | `AUDIT_MAX_ENTRIES`, `AUDIT_RETENTION_DAYS` | Trims execution audit log after append. |
| **53** | `FALLBACK_BACKEND` (`ollama` \| `vllm` \| `openai`) | Primary backend 5xx/429 or network error → try fallback. |
| **54** | `OTEL_ENABLED=1`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | OpenTelemetry OTLP HTTP (self-hosted listen path only; not started on Vercel serverless). |

`GET /config` exposes: `storageBackend`, `streamAgentFinalEnabled`, `fallbackBackend`, `otelEnabled`.
