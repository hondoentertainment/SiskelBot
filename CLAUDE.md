# CLAUDE.md

Codebase conventions and context for AI assistants working on SiskelBot.

## Project overview

SiskelBot is a realtime streaming assistant proxy for Ollama, vLLM, and OpenAI. It is a Node.js Express server with a vanilla JS frontend (single-page app). The server proxies chat completions with streaming support, provides workspace/user management, task planning, agent orchestration, and integrations with GitHub, Vercel, Jira, Linear, Slack, and Discord.

## Architecture

### server.js (1,073 lines)

Main Express application. Mounts middleware (helmet, CORS, compression, rate limiting, session, passport), initializes storage and plugins, then calls `mountAllRoutes(app, deps)` which registers all route modules. Handles WebSocket upgrade for realtime presence and server startup/shutdown lifecycle.

### routes/ -- 24 route modules

| Module | Responsibility |
|--------|---------------|
| `chat.js` | `/v1/chat/completions` -- streaming and non-streaming proxy to backends |
| `agent.js` | Agent mode chat, swarm mode orchestration |
| `context.js` | Knowledge base CRUD (add, search, list, delete documents) |
| `recipes.js` | Recipe CRUD and execution |
| `templates.js` | Workspace template management |
| `schedules.js` | Scheduled job CRUD and manual triggers |
| `webhooks.js` | Webhook registration and management |
| `notifications.js` | User notification list, mark-read |
| `workspaces.js` | Workspace CRUD, invite codes, membership |
| `teams.js` | Team membership, roles, activity log |
| `auth.js` | Login, logout, session, OAuth callbacks |
| `admin.js` | Admin dashboard data, user/workspace listing, audit log |
| `api-keys.js` | API key CRUD for admin |
| `usage.js` | Usage tracking, analytics, cost estimation |
| `quotas.js` | Per-workspace token quota management |
| `backup.js` | Backup creation, listing, restoration |
| `eval.js` | Eval set management and execution |
| `plugins.js` | Plugin marketplace, install/uninstall, sandbox execution |
| `embeddings.js` | Embedding generation and semantic search |
| `conversation.js` | Conversation branching and tree navigation |
| `health.js` | Health checks, readiness, region status |
| `mcp.js` | Model Context Protocol server and client endpoints |
| `ab-router.js` | A/B routing configuration and stats |
| `openapi.js` | OpenAPI spec serving and SDK generation |

### lib/ -- 111 modules (grouped by category)

**Agent system (12 modules)**
`agent-loop.js`, `agent-tools.js`, `agent-defaults.js`, `agent-hooks.js`, `agent-iterations.js`, `agent-context-trim.js`, `agent-stagnation.js`, `agent-trajectory.js`, `agent-fetch-url.js`, `swarm.js`, `swarm-intent-v2.js`, `specialists.js`

**Auth and access control (8 modules)**
`auth.js`, `oauth.js`, `oidc.js`, `saml.js`, `sso.js`, `admin-auth.js`, `scope-middleware.js`, `api-key-scopes.js`

**Storage (7 modules)**
`storage.js`, `json-path-store.js`, `storage-sqlite-kv.js`, `storage-postgres-kv.js`, `storage-replication.js`, `storage-eval.js`, `backup.js`

**Knowledge and RAG (5 modules)**
`knowledge-store.js`, `knowledge-chunking.js`, `knowledge-url-fetch.js`, `embeddings.js`, `grounding.js`

**Observability and tracing (8 modules)**
`metrics.js`, `tracing.js`, `tracing-spans.js`, `trace-recorder.js`, `trace-replay.js`, `otel-context.js`, `log-sanitizer.js`, `error-reporting.js`

**Evaluation (6 modules)**
`eval-runner.js`, `eval-sets.js`, `eval-judge.js`, `eval-golden-trace.js`, `eval-staging-trace.js`, `eval-agent-activity.js`

**Integrations (8 modules)**
`mcp-server.js`, `mcp-client.js`, `slack-bot.js`, `discord-bot.js`, `email-notifications.js`, `jira-integration.js`, `linear-integration.js`, `webhooks.js`

**Scheduling and automation (3 modules)**
`scheduler.js`, `schedules.js`, `notifications.js`

**Plugins (4 modules)**
`plugins-loader.js`, `plugin-sandbox.js`, `plugin-worker.js`, `plugin-marketplace.js`

**Infrastructure (10 modules)**
`circuit-breaker.js`, `idempotency.js`, `leader-election.js`, `region-health.js`, `ab-router.js`, `llm-stream-sse.js`, `backend-fetch.js`, `realtime.js`, `quotas.js`, `ocr.js`

**Workspace and users (8 modules)**
`teams.js`, `workspace-lifecycle.js`, `workspace-templates.js`, `workspace-agent-settings.js`, `workspace-memory-tool.js`, `conversation-tree.js`, `usage-tracker.js`, `analytics.js`

**API keys and audit (7 modules)**
`api-keys.js`, `api-key-audit.js`, `audit-lifecycle.js`, `audit-query.js`, `audit-trim.js`, `audit-s3-archive.js`, `admin-data.js`

**Other (3 modules)**
`openapi-spec.js`, `action-executor.js`, `tool-validation.js`

### client/ -- Single-page application

Vanilla JS, no build step. Served as static files by Express.

| File | Purpose |
|------|---------|
| `index.html` | Main chat interface |
| `admin.html` | Admin dashboard |
| `eval.html` | Eval runner UI |
| `marketplace.html` | Plugin marketplace UI |
| `templates.js` | Template management logic |
| `automations.js` | Automation/schedule UI logic |
| `use-cases.js` | Use-case gallery logic |
| `i18n.js` | Internationalization support |
| `sw.js` | Service worker for offline/PWA support |
| `js/offline-queue.js` | Offline request queuing |
| `js/stream-ui-batch.js` | Batched streaming UI updates |

### Other top-level directories

| Directory | Purpose |
|-----------|---------|
| `bin/` | CLI entry point (`siskelbot.js`) |
| `tests/` | 61 test files (unit + integration + e2e) |
| `docs/` | Operational docs (RUNBOOK, DEPLOYMENT, DOCKER, PLUGINS, WEBHOOKS, etc.) |
| `scripts/` | Utility scripts (smoke tests, syntax checks, test runner, vendor tooling) |
| `plugins/` | Plugin packs, manifests, and example configurations |
| `electron/` | Electron desktop wrapper |
| `vscode-extension/` | VS Code extension for SiskelBot integration |
| `sdk/` | Generated client SDK (from OpenAPI spec) |
| `grafana/` | Grafana dashboard JSON template |

## Tech stack

- **Runtime:** Node.js (>=18), ES modules throughout (no TypeScript)
- **Server:** Express
- **Auth:** Passport (GitHub OAuth, Google OAuth), OIDC, SAML, session cookies, API key auth
- **Storage:** JSON files (default, `data/` directory), SQLite KV (`STORAGE_BACKEND=sqlite`), PostgreSQL (`STORAGE_BACKEND=postgres` + `DATABASE_URL`), Redis (caching/pubsub)
- **Observability:** OpenTelemetry, Prometheus metrics (`GET /metrics` when `ENABLE_METRICS=1`), Grafana dashboards
- **Realtime:** WebSocket for live notifications and presence
- **Testing:** Node.js built-in test runner (`node --test`) + supertest + Playwright (e2e)
- **PWA:** Service worker, web app manifest, offline support
- **MCP:** Model Context Protocol server and client for tool interop

## Key commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the server |
| `npm run dev` | Start with file watching (development) |
| `npm test` | Run all tests |
| `npm run test:ci` | Run tests in CI mode |
| `npm run test:coverage` | Run tests with c8 coverage |
| `npm run test:load` | Run load/stress tests |
| `npm run test:e2e` | Run Playwright end-to-end tests |
| `npm run lint` | Run ESLint + syntax check |
| `npm run smoke-test:ci` | Smoke tests against a live server |
| `npm run build:client` | Bundle client assets |
| `npm run build:sdk` | Generate client SDK from OpenAPI spec |
| `npm run openapi:generate` | Regenerate OpenAPI spec from route metadata |
| `npm run eval:ci` | Run eval sets in CI mode |

## CLI commands

The CLI (`bin/siskelbot.js`) provides 18 commands:

| Command | Description |
|---------|-------------|
| `chat "message"` | Send a message, stream response (supports `--agent`, `--swarm`, `--model`) |
| `init` | Initialize a new SiskelBot project with config |
| `config` | Show current configuration (backend, URL, auth status) |
| `context list` | List knowledge base documents |
| `context add` | Add a document from file or stdin |
| `recipes list` | List saved recipes |
| `recipes run <name>` | Execute a recipe by name |
| `plugin create` | Scaffold a new plugin |
| `workspace list` | List accessible workspaces |
| `workspace create` | Create a new workspace |
| `search <query>` | Search across context and knowledge base |
| `export` | Export workspace data |
| `migrate` | Run storage migrations |
| `health` | Check server health status |
| `admin` | Admin operations (users, audit, quotas) |
| `backup` | Create or restore backups |
| `schedules` | List and manage scheduled jobs |
| `webhooks` | List and manage webhook subscriptions |

## Testing

61 test files: 44 unit/integration tests in `tests/*.test.js` plus 6 Playwright e2e specs in `tests/e2e/` and additional generated test files. Tests use the Node.js built-in test runner (`node --test`) with supertest for HTTP assertions.

Run a single test file:
```bash
node --test tests/foo.test.js
```

Run all tests:
```bash
npm test
```

Run with coverage:
```bash
npm run test:coverage
```

Run e2e tests:
```bash
npm run test:e2e
```

Run eval sets in CI:
```bash
npm run eval:ci
```

Run load tests:
```bash
npm run test:load
```

## Coverage

Coverage is enforced in CI via `c8` with thresholds defined in `.c8rc.json`:

| Metric | Minimum |
|--------|---------|
| Lines | 50% |
| Functions | 45% |
| Branches | 40% |
| Statements | 50% |

View the HTML report after running coverage:
```
open coverage/lcov-report/index.html
```

## Storage backends

| Backend | Config | Notes |
|---------|--------|-------|
| **JSON** (default) | `STORAGE_PATH=./data` | Files in `data/` directory. Zero dependencies. |
| **SQLite** | `STORAGE_BACKEND=sqlite` | Key-value store via SQLite. |
| **PostgreSQL** | `STORAGE_BACKEND=postgres`, `DATABASE_URL=...` | Full relational backend. |

## Environment variables

Key variables (see `.env.example` for the full list):

| Variable | Purpose |
|----------|---------|
| `BACKEND` | Backend provider: `ollama`, `vllm`, or `openai` |
| `API_KEY` | Protects `/v1/chat/completions` |
| `OPENAI_API_KEY` | Required when `BACKEND=openai` |
| `ADMIN_API_KEY` | Protects `/admin` and `/api/admin/*` endpoints |
| `DATABASE_URL` | PostgreSQL connection string (when `STORAGE_BACKEND=postgres`) |
| `SESSION_SECRET` | Secret for session cookies (required for OAuth) |
| `OLLAMA_URL` | Ollama server URL (default `http://localhost:11434`) |
| `VLLM_URL` | vLLM server URL (default `http://localhost:8000`) |
| `USER_API_KEYS` | Comma-separated `key:userId` pairs for user auth |
| `REDIS_URL` | Redis connection string (for caching and pubsub) |
| `MCP_SERVERS` | Comma-separated MCP server URLs for tool interop |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token for Slack integration |
| `DISCORD_BOT_TOKEN` | Discord bot token for Discord integration |
| `SMTP_HOST` | SMTP server hostname for email notifications |
| `SMTP_PORT` | SMTP server port (default `587`) |
| `SMTP_USER` | SMTP username |
| `SMTP_PASS` | SMTP password |
| `JIRA_BASE_URL` | Jira instance URL for issue tracking integration |
| `JIRA_API_TOKEN` | Jira API token |
| `JIRA_USER_EMAIL` | Jira user email for authentication |
| `LINEAR_API_KEY` | Linear API key for issue tracking integration |
| `SEARCH_API` | External search API endpoint (for `web_search` agent tool) |
| `AGENT_CODE_EXECUTE` | Enable code execution agent tool (`1` to enable) |
| `AGENT_DB_QUERY` | Enable database query agent tool (`1` to enable) |
| `PLUGIN_REGISTRY_URL` | URL for external plugin registry |

## Agent system

### Agent modules

- **lib/agent-loop.js** -- Single-agent tool-call loop. The LLM calls tools, results feed back, loop continues until text response or max iterations.
- **lib/agent-tools.js** -- Tool definitions and execution. 16 tools registered (see below).
- **lib/agent-defaults.js** -- Default agent configuration (model, temperature, system prompt).
- **lib/agent-hooks.js** -- Lifecycle hooks (`beforeToolCall`, `afterToolCall`) for logging and validation.
- **lib/agent-iterations.js** -- Max iteration resolution and guard rails.
- **lib/agent-context-trim.js** -- Context window trimming to stay within token limits.
- **lib/agent-stagnation.js** -- Detects agent loops producing no progress and forces termination.
- **lib/agent-trajectory.js** -- Records and analyzes agent execution trajectories.
- **lib/agent-fetch-url.js** -- Allowlisted URL fetching for agent tools.
- **lib/swarm.js** -- Multi-agent orchestration. Specialists run in parallel.
- **lib/swarm-intent-v2.js** -- Intent classification for swarm routing.
- **lib/specialists.js** -- Specialist agent definitions (researcher, executor, synthesizer).

### Agent tools (16 tools)

| Tool | Description |
|------|-------------|
| `execute_step` | Execute a recipe step (build, deploy, copy) |
| `search_context` | Keyword search over knowledge base documents |
| `list_context` | List all indexed document titles |
| `semantic_search_context` | Meaning-based search using embeddings |
| `get_context_document` | Load full text of a knowledge document by ID |
| `list_recipes` | List saved recipes in the workspace |
| `get_recipe` | Get a recipe by name with its steps |
| `remember_workspace_fact` | Persist a fact to workspace memory |
| `list_workspace_memory` | List approved workspace memory snippets |
| `fetch_allowed_url` | HTTP GET an allowlisted URL |
| `web_search` | Search the web via external search API (`SEARCH_API`) |
| `code_execute` | Execute code in a sandboxed environment (`AGENT_CODE_EXECUTE=1`) |
| `create_document` | Create a new knowledge document in the workspace |
| `schedule_task` | Schedule a task for future execution |
| `send_notification` | Send a notification to a user or channel |
| `query_database` | Run a read-only query against the storage backend (`AGENT_DB_QUERY=1`) |

## Code style

- **ES modules** (`import`/`export`) everywhere. No CommonJS `require`.
- **No TypeScript.** Plain JavaScript only.
- **Minimal comments.** Code should be self-documenting.
- **Express middleware chains.** Routes use standard Express `(req, res, next)` patterns.
- **No build step** for the frontend. Vanilla JS served directly.

## Route structure

Routes are organized into modular files under `routes/` and mounted via `mountAllRoutes(app, deps)` in `server.js`. The `dualRegister` pattern mounts routes at both `/api/` (legacy) and `/api/v1/` (current). Legacy routes return the header `X-API-Deprecated: use /api/v1/`.

## Important patterns

- **mountAllRoutes:** Central function that wires all 24 route modules to the Express app with shared dependencies (storage, scheduler, realtime, etc.).
- **dualRegister:** Helper that registers Express routes at both `/api/` and `/api/v1/` paths simultaneously.
- **apiError:** Helper function for consistent JSON error responses with status codes and error codes.
- **Circuit breaker:** `lib/circuit-breaker.js` wraps backend calls. After consecutive failures (default 5), returns 503 immediately until cooldown expires. Configured via `CIRCUIT_BREAKER_FAILURES` and `CIRCUIT_BREAKER_COOLDOWN_MS`.
- **Storage scoping:** Storage is scoped by `userId` and `workspaceId`. Anonymous access uses `anonymous/default`.
- **Leader election:** `lib/leader-election.js` ensures only one instance runs scheduled jobs in multi-replica deployments.
- **A/B routing:** `lib/ab-router.js` routes requests to different backends based on experiment configuration.

## What NOT to look for here

- Build instructions for Electron are in `docs/DESKTOP.md`.
- Deployment guides are in `docs/DEPLOYMENT.md` and `docs/DOCKER.md`.
- Operational runbooks are in `docs/RUNBOOK.md`.
- Plugin development guide is in `docs/PLUGINS.md` and `docs/PLUGIN_API.md`.
- Multi-region HA setup is in `docs/MULTI_REGION_HA.md`.
- Webhook configuration is in `docs/WEBHOOKS.md`.
