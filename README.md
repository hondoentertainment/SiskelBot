# Experiment Agent

Realtime streaming assistant proxy for Ollama, vLLM, or OpenAI. Node.js proxy that streams chat completions to clients.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Choose a backend

**Ollama (recommended on Windows):**

```bash
# Install from https://ollama.ai, then:
ollama pull llama3.2
```

**vLLM (Linux/WSL):**

```bash
pip install vllm
vllm serve meta-llama/Llama-3-8B-Instruct --max-model-len 4096
```

### 3. Start the proxy

```bash
# For Ollama (default for quick start)
set BACKEND=ollama
npm start

# Or copy .env.example to .env and set BACKEND=ollama
```

Runs on `http://localhost:3000`.

### 4. Use the app

- Open `http://localhost:3000` in a browser
- API: `POST http://localhost:3000/v1/chat/completions` (OpenAI-compatible)
- **API docs:** [http://localhost:3000/api/docs](http://localhost:3000/api/docs) (Swagger UI)
- **Admin dashboard:** [http://localhost:3000/admin](http://localhost:3000/admin) (requires `ADMIN_API_KEY` or user in `QUOTA_ADMIN_USER_IDS`)

## Backends

| Backend | Env vars | Notes |
|---------|----------|-------|
| **Ollama** | `BACKEND=ollama`, `OLLAMA_URL` | Local, Windows-friendly |
| **vLLM** | `BACKEND=vllm`, `VLLM_URL` | High throughput, Linux/WSL |
| **OpenAI** | `BACKEND=openai`, `OPENAI_API_KEY` | Cloud API |

## Environment

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND` | `ollama` | `ollama`, `vllm`, or `openai` |
| `VLLM_URL` | `http://localhost:8000` | vLLM server URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OPENAI_API_KEY` | — | Required for OpenAI backend |
| `PORT` | `3000` | Proxy port |
| `API_KEY` | — | Optional; protects /v1/chat/completions |
| `GITHUB_TOKEN` | — | Optional; for GitHub proxy (repos, repo details, issues). Set in server env only. |
| `VERCEL_TOKEN` | — | Optional; for Vercel proxy (deployments, projects). Set in server env only. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `60` | Max requests per window per IP |
| `RATE_LIMIT_MAX_PER_USER` | same as `RATE_LIMIT_MAX` | Phase 21: Per-user limit when auth configured |
| `QUOTA_TOKENS_PER_WORKSPACE` | — | Phase 21: Tokens per workspace per period. Unset = no quota. |
| `QUOTA_WORKSPACE_PERIOD_DAYS` | `30` | Phase 21: Quota period |
| `QUOTA_ADMIN_USER_IDS` | — | Phase 21: Comma-separated userIds that bypass quota; also grants admin dashboard access |
| `ADMIN_API_KEY` | — | Phase 25: Protects `/admin` and `/api/admin/*`. Use Bearer or x-admin-api-key header. |
| `STORAGE_PATH` | `./data` | Directory for persistent storage JSON files (context.json, recipes.json, conversations.json) |
| `USER_API_KEYS` | — | Phase 14: Optional; comma-separated `key:userId` pairs for user auth. When set, storage and workspaces require `Authorization: Bearer <key>` or `x-user-api-key`. |
| `ANALYTICS_COST_PER_1K_INPUT` | 0.002 | Phase 18: $ per 1K input tokens for OpenAI cost estimate. Ollama/vLLM = local. |
| `ANALYTICS_COST_PER_1K_OUTPUT` | 0.006 | Phase 18: $ per 1K output tokens. |
| `ENABLE_SCHEDULED_RECIPES` | — | Phase 16: Set to `1` to enable scheduled recipe execution (local node-cron). Requires `ALLOW_RECIPE_STEP_EXECUTION=1`. |
| `CRON_SECRET` | — | Phase 16: Optional; protects `GET /api/cron` for Vercel Cron. Pass via `Authorization: Bearer` or `?secret=`. |

## Phase 16: Scheduled & Automated Recipes

Schedule recipes to run at specified times (cron format). In the Recipes panel, click **Schedule** on a recipe to set a cron expression (e.g. `0 9 * * 1-5` for 9am weekdays). Schedules are stored in `data/schedules.json`. Requires `ENABLE_SCHEDULED_RECIPES=1` (local) or Vercel Cron (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

- **Local:** `node-cron` runs in-process when `ENABLE_SCHEDULED_RECIPES=1`.
- **Vercel:** `vercel.json` cron triggers `GET /api/cron` every minute; set `CRON_SECRET` to protect it.
- **Audit:** Scheduled runs log to `data/execution-audit.json` with `source: "scheduled"`.

## Phase 14: User Authentication & Workspaces

When `USER_API_KEYS` (or `data/users.json`) is configured, the app supports per-user workspaces. Storage (context, recipes, conversations) is scoped by `userId` and `workspaceId`.

- **Auth flow:** API key per user via `Authorization: Bearer <key>` or `x-user-api-key` header.
- **Workspaces:** Each user has a default workspace; create more via `POST /api/workspaces`.
- **Client:** When auth is configured, Settings shows User API key; header shows workspace switcher.
- **No auth:** When `USER_API_KEYS` is unset, app behaves as before (anonymous user, default workspace).
- **Migration:** Existing data in `data/context.json` etc. migrates to `data/users/anonymous/workspaces/default/` on first access.

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for full Phase 14 details.

## Phase 29: Multi-Tenant Teams & Collaboration

When auth is configured, workspaces can be **personal** or **team**. Team workspaces support invite codes, roles (admin, member, viewer), shared context/recipes/conversations, and an activity feed.

- **Create team:** Workspace panel → Create → Type: Team. Creates workspace and registers you as admin.
- **Invite:** Select team workspace → Generate invite → Share link (`?join=CODE`) or code.
- **Join:** Workspace panel → Join → Enter code. Or visit `/?join=CODE` to auto-open join flow.
- **Members & activity:** For team workspaces, expand Members and Activity in the workspace panel.
- **Backward compat:** Existing workspaces default to personal; no breaking changes.

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for Phase 29 API and troubleshooting.

## Phase 19: OAuth & SSO

When OAuth credentials are configured (GitHub and/or Google), users can sign in with "Sign in with GitHub" or "Sign in with Google" in Settings. Session cookie auth takes precedence over API key when both are present. API key auth still works for programmatic access.

- **Env vars:** `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, and `BASE_URL` (for production callbacks).
- **Client:** Shows OAuth sign-in buttons when auth required and OAuth configured; Logout when session exists; fetches `/auth/me` on load.
- **Backward compat:** No OAuth env = API key or anonymous only.

## Phase 21: Per-User & Per-Workspace Quotas

When auth is configured, chat is rate-limited per user (RATE_LIMIT_MAX_PER_USER) instead of per IP. Set `QUOTA_TOKENS_PER_WORKSPACE` to cap tokens per workspace per period (default 30 days). When exceeded, chat returns 429 with `QUOTA_EXCEEDED`. Admin override: `QUOTA_ADMIN_USER_IDS=user1,user2`. Response headers: `X-Quota-Limit`, `X-Quota-Remaining`, `X-Quota-Reset`. Usage panel shows quota when endpoint returns it.

## Phase 33: Real-Time Sync & Presence

WebSocket-based live notifications. When recipes complete, schedules run, or plans are created, notifications are pushed instantly to connected clients instead of 30s polling. Fallback to polling when WebSocket is unavailable. Optional presence shows who's online per workspace. Requires Node.js server (not available on Vercel serverless; client falls back to polling).

- **API:** `GET /api/ws-token?workspace=X` (returns token for WebSocket), `GET /api/workspaces/:id/presence` (online users)
- **Client:** Connects to WebSocket on load; reconnect with exponential backoff; workspace change triggers reconnect

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for Phase 33 details.

## Phase 25: Admin Dashboard

The admin dashboard at `/admin` provides a server-side UI for users, workspaces, quotas, usage, system health, and recent audit log.

- **Access:** Requires `ADMIN_API_KEY` (Bearer or x-admin-api-key header) or sign in via OAuth as a user in `QUOTA_ADMIN_USER_IDS`.
- **Sections:** Users (from data/users, oauth-users), Workspaces (with quota), Usage summary, Quota status, System health (backend, integrations), Recent audit log.
- **Actions:** Override quota for a workspace (set custom token limit or clear override).
- **Client:** `client/admin.html` — dark theme consistent with main app.

## Phases 35–39: Production Hardening

Five additional phases to productionize the app:

| Phase | Feature | Env vars |
|-------|----------|----------|
| **35** | Content Security Policy (CSP) | `ENABLE_CSP=1`, `CSP_ENFORCE=1` (optional) |
| **36** | Log sanitization | Automatic — API keys/tokens never logged |
| **37** | Backend circuit breaker | `CIRCUIT_BREAKER_FAILURES`, `CIRCUIT_BREAKER_COOLDOWN_MS` |
| **38** | Error reporting webhook | `ERROR_REPORT_WEBHOOK_URL` (uncaught errors POSTed) |
| **39** | Deployment smoke tests | `npm run smoke-test`, `npm run smoke-test:ci --live-only` |

- **CSP:** Report-only by default; set `CSP_ENFORCE=1` after validating.
- **Circuit breaker:** After 5 consecutive backend failures, returns 503 immediately until cooldown.
- **Smoke test:** Run `node scripts/smoke-test.js [BASE_URL]` after deploy. CI runs it against a started server.

See [docs/RUNBOOK.md](docs/RUNBOOK.md) for Phase 35–39 details.

## Production (Vercel)

For Vercel deployment, Ollama and vLLM (localhost) will not work. Use the OpenAI backend and secure the API:

1. Connect your GitHub repo at [vercel.com](https://vercel.com) → Add New Project.
2. Vercel uses `vercel.json` for build/routes. In **Project → Settings → Environment Variables**, add (for Production):
   - `BACKEND` = `openai` (required; Ollama localhost won't work)
   - `OPENAI_API_KEY` = your OpenAI API key (required)
   - `API_KEY` = a secret key to protect `/v1/chat/completions` (strongly recommended)
3. Redeploy after adding variables.

See [Vercel environment variables documentation](https://vercel.com/docs/projects/environment-variables) for details.

For API-key protected deployments, users can enter the key in the in-app **Settings** panel. The key is stored only in `sessionStorage`.

## Personal Workflow Memory (Phase 2)

### Task templates

Preset task types (Coding, Deployment, Research, Content, Ops) set system prompt and optional model. Stored in `siskelbot-templates` (localStorage). Default templates are defined in `client/templates.defaults.json` and merged with user-created ones (ids starting with `user-`).

### Profiles

Switch between saved profiles (name + template + model + system prompt) via the header dropdown. Stored in `siskelbot-profiles` (localStorage). Default profiles: "Coding", "Quick ops", "Detailed research".

### Searchable history

Search input filters displayed messages by content (client-side). Shows match count (e.g. `3 / 12`). Search preference persisted in sessionStorage (`siskelbot-history-search`).

### Storage keys

| Key | Storage | Description |
|-----|---------|-------------|
| `siskelbot-messages` | localStorage | Chat messages + metadata (`_version`, `pinned`, `tags`) |
| `siskelbot-templates` | localStorage | Task templates (`_version`, `templates`) |
| `siskelbot-profiles` | localStorage | Profiles + `activeProfileId` |
| `siskelbot-install-dismissed` | localStorage | Phase 20: Install banner dismissed (`1` = hidden) |
| `siskelbot-history-search` | sessionStorage | Last search query |
| `siskelbot-api-key` | sessionStorage | Deployment API key (when configured) |

All payloads include `_version: 1` for future migration. On load, data is migrated when the version changes.

### Pin and tags

- **Pin**: Pin a conversation (metadata stored with chat). Pinned state persists across sessions.
- **Tags**: Optional `tags: string[]` on conversation metadata. Comma-separated in the UI.

## UX additions

- Markdown rendering for assistant replies, including code blocks and links
- Persistent chat history with continue, export, and import
- Voice input and text-to-speech controls
- Generation controls for `temperature`, `top_p`, and `max_tokens`
- Retry-last and protected deployment API key entry in the UI
- Keyboard shortcut: `Ctrl/Cmd + Enter` to send
- Installable PWA shell with offline asset caching

## Personal Workflow Memory (Phase 2)

### Task templates

Task templates are preset configurations (system prompt + optional model) for common workflows. Default templates: **Coding**, **Deployment**, **Research**, **Content**, **Ops**. Select a template from the dropdown to apply its system prompt and model. User-created templates are merged with defaults and stored in localStorage.

### Profiles

Profiles bundle a name, template, model, and system prompt for quick switching. Default profiles: **Coding**, **Quick ops**, **Detailed research**. Use the Profile dropdown in the header to switch. Your active profile and custom profiles persist across sessions.

### Searchable history

The search input above the chat filters displayed messages by content (client-side). Match count shows `N / total`. The search query persists in `sessionStorage` for the current session.

### Pin and tags

- **Pin** – Pin the current conversation (stored in metadata). Pinned state persists across reloads.
- **Tags** – Add optional tags (comma-separated) to conversation metadata for organization.

### Storage keys (localStorage)

| Key | Contents |
|-----|----------|
| `siskelbot-messages` | Versioned payload: `{ _version: 1, messages, pinned, tags }` |
| `siskelbot-templates` | Versioned payload: `{ _version: 1, templates }` (user-created only) |
| `siskelbot-profiles` | Versioned payload: `{ _version: 1, profiles, activeProfileId }` |

All payloads use `_version: 1` for future migration. Default templates and profiles are defined in `client/templates.defaults.json` and merged with stored data on load.

## Toolchain Integration Hub (Phase 4)

When `GITHUB_TOKEN` or `VERCEL_TOKEN` is set in server env, the client shows an **Integrations** panel (collapsible in the header) with status and refresh actions.

| Endpoint | Description | Requires |
|----------|-------------|----------|
| `GET /api/integrations/status` | `{ github, vercel }` booleans | — |
| `GET /api/github/repos` | List user repos | `GITHUB_TOKEN` |
| `GET /api/github/repo/:owner/:repo` | Repo details | `GITHUB_TOKEN` |
| `GET /api/github/issues/:owner/:repo` | List issues | `GITHUB_TOKEN` |
| `GET /api/vercel/deployments` | List deployments | `VERCEL_TOKEN` |
| `GET /api/vercel/projects` | List projects | `VERCEL_TOKEN` |

**Security:** Tokens stay server-side; routes return `503` with a hint when a token is missing. GitHub/Vercel routes are rate-limited (30/min). Route params (`owner`, `repo`) are validated to prevent injection.

## Task planning (Phase 3: Action-Oriented Agent)

The app includes a **task planning** flow that turns conversational intent into structured, step-by-step plans. No shell or code execution—plans are for display and manual execution only.

### API: `POST /v1/tasks/plan`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | array | yes | Non-empty array of `{ role, content }` (OpenAI format) |
| `model` | string | no | Model name; falls back to backend default |

**Response:** `{ plan, raw }` — `plan` is the validated task object; `raw` is the raw LLM response text.

**Protection:** Same rate limit and API key as `/v1/chat/completions`.

**Errors:** `400` with `PARSE_ERROR` or `VALIDATION_ERROR` when the LLM output cannot be parsed or validated against the task schema (see `docs/TASK_SCHEMA.md`).

### Client flow

1. Send a message (or type one and click **Plan task**).
2. Click **Plan task** to call `/v1/tasks/plan`.
3. The plan appears in a structured card: name, steps, and optional “Requires approval” badge.
4. **Copy plan** — copies a formatted summary to the clipboard.
5. **Execute** — copies the plan (e.g. “Run these steps: …”) to the clipboard. For plans with `requiresApproval`, a confirmation modal appears before copy. There is no actual execution; the app only copies to clipboard.

### Schema

See [docs/TASK_SCHEMA.md](docs/TASK_SCHEMA.md) for the full JSON schema.

## Phase 15: Agentic Autonomy Mode

When **Agent mode** is enabled (Settings → Agent mode), the assistant can use tools to search context, list documents, fetch recipes, and optionally execute steps (build, deploy). The server runs a tool-call loop: the LLM can call tools, results are fed back, and the loop continues until the model responds with text or max iterations are reached.

### Tools

| Tool | Description |
|------|-------------|
| `search_context` | Search the knowledge base by query (read-only) |
| `list_context` | List indexed context document titles (read-only) |
| `get_recipe` | Fetch a saved recipe by name (read-only) |
| `execute_step` | Run a build or deploy step (requires approval) |

### Safety

- **Read-only tools** (`search_context`, `list_context`, `get_recipe`) run without user approval.
- **execute_step** requires both server `ALLOW_RECIPE_STEP_EXECUTION=1` and the client "Allow recipe step execution" toggle.
- Max iterations configurable via `MAX_AGENT_ITERATIONS` (default: 5).

### API

- Reuses `POST /v1/chat/completions`. When `agentMode: true` is in the body, the server injects tools and runs the agent loop. The response streams the final text after tool execution.

### Agent Swarm (production-grade multi-agent)

When `ENABLE_AGENT_SWARM=1`, enable **Swarm mode** in Settings for multi-specialist orchestration:

- **Specialists:** researcher (search, list context), executor (recipes, execute_step), synthesizer (combines outputs).
- **Intent detection:** routes the query to eligible specialists automatically.
- **Parallel execution:** specialists run in parallel; tool calls within agent loop also run in parallel.
- **Observability:** webhook events `swarm_started`, `swarm_specialist_completed`, `swarm_completed`; response headers `X-Swarm-Agents`, `X-Swarm-Duration-Ms`.

**API:** `POST /v1/chat/completions` with `agentMode: true`, `swarmMode: true`; or `POST /v1/agent/swarm`; or `POST /v1/swarm` (direct tool execution, no LLM synthesis).

See [docs/AGENT_MODE.md](docs/AGENT_MODE.md) for details.

## Phase 17: Plugins & Extensions

Recipe step actions are extensible via a plugin registry. Built-in actions: `build`, `deploy`, `copy`. The `webhook` action POSTs to a URL (requires `ALLOW_WEBHOOK_ACTIONS=1`, HTTPS only, rate-limited 5/min per URL).

### Config

- **plugins/config.json** or **PLUGINS_PATH** — load custom actions at startup.
- Schema: `{ actions: [{ name, type: "webhook"|"builtin", config }] }`
- Webhook type: `config.url` (required), `config.headers`, `config.body`.
- Builtin type: `config.target` — alias to existing action (`build`, `deploy`, `copy`).

### API

- **GET /api/plugins/actions** — list registered action names (for recipe step dropdown). Protected by user auth when Phase 14 is configured.

### Client

- Recipe create/edit: **Add step** dropdown populated from `GET /api/plugins/actions`. Hint shows available actions in the Recipes panel.

### Security

- No `eval()`, no `require(userPath)`. Config only.
- Webhook URLs must be HTTPS; localhost and private IPs rejected.
- See [docs/PLUGINS.md](docs/PLUGINS.md) for full details.

## Phase 23: API Versioning & Public API Docs

Stable API routes use the `/api/v1/` prefix. Legacy `/api/*` routes still work but return header `X-API-Deprecated: use /api/v1/`.

- **Versioned routes:** `/api/v1/context`, `/api/v1/recipes`, `/api/v1/conversations`, `/api/v1/workspaces`, `/api/v1/usage/summary`, `/api/v1/analytics/dashboard`, `/api/v1/webhooks`, `/api/v1/schedules`, `/api/v1/plugins/actions`, `/api/v1/execute-step`, etc.
- **Chat:** `/v1/chat/completions` (OpenAI spec) — unchanged.
- **API docs:** [GET /api/docs](http://localhost:3000/api/docs) — Swagger UI; OpenAPI spec at [GET /api/docs/openapi.json](http://localhost:3000/api/docs/openapi.json).
- **Auth:** Bearer token (API key) or OAuth when configured.

See [docs/RUNBOOK.md](docs/RUNBOOK.md#phase-23-api-versioning--deprecation) for deprecation timeline.

## Phase 22: Event Webhooks & Notifications

Subscribe to events (`message_sent`, `plan_created`, `recipe_executed`, `schedule_completed`) and receive POST payloads at your URL.

- **Storage:** `data/webhooks.json` keyed by workspace
- **API:** `GET/POST/DELETE /api/webhooks` (auth required)
- **Client:** Integrations panel → Webhooks form (URL, events checkboxes, optional secret)
- **Delivery:** Fire-and-forget with 2 retries (1s, 5s); HMAC signing when secret set
- **Security:** Rate limit 5/min per URL; HTTPS only; `ALLOW_WEBHOOK_LOCALHOST=1` for dev

See [docs/WEBHOOKS.md](docs/WEBHOOKS.md) for event schema and examples.

## Phase 20: Mobile-First & PWA Polish

Mobile and PWA improvements for better touch and offline experience.

### Install prompt

- Captures `beforeinstallprompt` when the app is installable (HTTPS, meets PWA criteria).
- Shows a minimal "Install app" banner when criteria are met.
- Dismissal stored in `localStorage` (`siskelbot-install-dismissed`) so the banner does not reappear after the user dismisses it.

### Offline support

- **Offline indicator:** Header shows "Offline" when `navigator.onLine` is false.
- **Cached app shell:** Service worker caches index.html, manifest, icons, and CDN scripts for offline load.
- **Conversation cache:** Recent conversations and messages are cached in the service worker when online. When offline, cached messages and the conversations list from localStorage are available for viewing.
- **Send when offline:** The send button is disabled when offline. Message queue/sync on reconnect is stubbed for future implementation.

### Touch targets

- Buttons and inputs have a minimum 44×44px touch target on viewports ≤768px.
- Extra padding on header buttons, send button, recipe/context items, and search/tags inputs.

### Gestures

- **Tap-outside-to-close:** Modals (Status report, Context add, Recipe create/schedule, Approval, Continue) close when the user taps the overlay outside the dialog.

### Viewport and layout

- Meta viewport set for responsive layout.
- Input area uses `scrollIntoView` on focus to avoid being covered by the mobile keyboard.
- Sticky input bar at the bottom on mobile (≤768px).

### Haptics (optional)

- `navigator.vibrate` on send (10ms), success (10–50–10ms pattern), and error (20–50–20ms) when supported by the device.

## Testing

### How to run tests

```bash
# All tests (node --test)
npm test

# Single file
node --test tests/server.test.js

# With spec reporter
node --test tests/**/*.test.js --test-reporter=spec
```

The CI workflow runs the same tests on pushes and pull requests.

### Test coverage

| Area | Files | Coverage |
|------|-------|----------|
| Server API | `tests/server.test.js` | Config, health, auth, integrations, task planning, workspaces, context, recipes, schedules, cron, execute-step, plugins, usage, automations |
| Auth | `tests/auth.test.js` | userAuth (anonymous, 401 when configured, Bearer/x-user-api-key) |
| Storage | `tests/storage.test.js` | sanitizeWorkspace, listWorkspaces, mergeItems, get, updateItem, deleteItem, createWorkspace |
| Scheduler | `tests/scheduler.test.js` | schedules list/upsert/remove, runDueJobs (skipped), runRecipeNow (not found) |
| Templates | `tests/templates.test.js` | Default templates and profiles schema |

See [docs/TEST_PLAN.md](docs/TEST_PLAN.md) for the full test plan (per-phase scenarios, API coverage matrix, priorities, manual checklist).

## Operations

For runbooks, troubleshooting, and verification steps, see [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Deploy to GitHub

### 1. Create repo and push

```bash
git init
git add .
git commit -m "feat: streaming assistant with multi-backend"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/experimentagent.git
git push -u origin main
```

### 2. Deploy to Render (optional)

1. Go to [render.com](https://render.com) → New → Web Service
2. Connect your GitHub repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add env vars (e.g. `BACKEND=openai`, `OPENAI_API_KEY=...`)

Or use the included `render.yaml` for one-click deploy.

**Note:** The proxy needs a backend (Ollama, vLLM, or OpenAI). For cloud deploy, use `BACKEND=openai` with an API key. Ollama/vLLM require a separate server.

### 3. Deploy to Vercel

1. Connect your GitHub repo at [vercel.com](https://vercel.com) → Add New Project.
2. Vercel uses the `vercel.json` config (builds, routes, functions).
3. Set env vars per [Production (Vercel)](#production-vercel) above.

## Custom domain (Vercel)

Custom domains are configured in the Vercel dashboard, not in `vercel.json`. For a full deployment and custom domain guide, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Quick steps:

### Add a custom domain

1. Open [Vercel Dashboard](https://vercel.com/dashboard) → select your project (SiskelBot).
2. Go to **Settings** → **Domains**.
3. Enter your domain (e.g. `assistant.yourdomain.com` or `yourdomain.com`) and click **Add**.
4. Vercel will show the DNS records you need to create.

### DNS setup

**Subdomain (e.g. `assistant.yourdomain.com`):**

| Type  | Name     | Value                     |
|-------|----------|---------------------------|
| CNAME | assistant | `cname.vercel-dns.com`     |

**Apex domain (e.g. `yourdomain.com`):**

| Type | Name | Value           |
|------|------|-----------------|
| A    | @    | `76.76.21.21`   |

Use your registrar’s DNS management to add the records. Exact names may vary; follow the values Vercel shows for your project.

### SSL (HTTPS)

After DNS propagates (often within minutes, sometimes up to 48 hours), Vercel automatically provisions a TLS certificate. HTTPS will be enabled with no extra steps.

### Verify

- In Vercel → Domains, confirm the domain shows a green “Valid configuration” status.
- Optional: `vercel alias set <deployment-url> <your-domain>` via the Vercel CLI for programmatic aliasing.

## Project layout

```
experimentagent/
├── server.js           # Express streaming proxy
├── vercel.json         # Vercel deploy config (builds, functions, routes; env vars in Dashboard)
├── docs/
│   ├── DEPLOYMENT.md   # Vercel deployment and custom domain setup
│   ├── RUNBOOK.md      # Ops runbook, troubleshooting, env checklist
│   ├── TASK_SCHEMA.md  # Task plan JSON schema (Phase 3)
│   └── TEST_PLAN.md    # Comprehensive test plan (Phases 1-18)
├── client/
│   ├── index.html           # Chat UI
│   ├── templates.js         # Templates/profiles (Phase 2)
│   ├── templates.defaults.json # Default templates and profiles
│   ├── app.webmanifest      # PWA manifest
│   ├── sw.js                # Service worker
│   └── icon.svg             # App icon
├── .github/workflows/
│   └── ci.yml          # CI on push
├── render.yaml         # Render deploy config
├── tests/
│   ├── server.test.js      # Server API integration tests
│   ├── auth.test.js        # Phase 14 user auth
│   ├── storage.test.js     # Phase 10 storage module
│   ├── scheduler.test.js   # Phase 16 schedules + scheduler
│   └── templates.test.js   # Template/profile schema (Phase 2)
├── package.json
└── .env.example
```
