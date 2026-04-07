# CLAUDE.md

Codebase conventions and context for AI assistants working on SiskelBot.

## Project overview

SiskelBot is a realtime streaming assistant proxy for Ollama, vLLM, and OpenAI. It is a Node.js Express server with a vanilla JS frontend (single-page app). The server proxies chat completions with streaming support, provides workspace/user management, task planning, agent orchestration, and integrations with GitHub, Vercel, Jira, Linear, Slack, and Discord.

## Architecture

### server.js (1,073 lines)

Main Express application. Mounts middleware (helmet, CORS, compression, rate limiting, session, passport), initializes storage and plugins, then calls `mountAllRoutes(app, deps)` which registers all route modules. Handles WebSocket upgrade for realtime presence and server startup/shutdown lifecycle.

### routes/ -- 37 route modules (including v2/)

| Module | Responsibility |
|--------|---------------|
| `chat.js` | `/v1/chat/completions` -- streaming and non-streaming proxy to backends |
| `agent-sessions.js` | Durable agent run grouping, session plan persistence, cancel in-process |
| `analytics.js` | Real-time analytics: usage trends, top models/users, agent stats, costs, errors |
| `auth.js` | Login, logout, session, OAuth callbacks |
| `admin.js` | Admin dashboard data, user/workspace listing, audit log |
| `backup.js` | Backup creation, listing, restoration |
| `collaboration.js` | Active collaborators, workspace activity feed |
| `context.js` | Knowledge base CRUD (add, search, list, delete documents) |
| `conversations.js` | Conversation CRUD, branching, tree navigation, export, sharing, search |
| `docs.js` | OpenAPI spec serving, Swagger UI |
| `eval.js` | Eval set management and execution |
| `execute.js` | Execute-step and automations/validate |
| `federation.js` | Cross-instance federation endpoints |
| `health.js` | Health checks, readiness, region status |
| `index.js` | Route index, mounts all route modules |
| `integrations.js` | Email, Jira, Linear integration endpoints |
| `knowledge.js` | Knowledge chunking config, parsers, knowledge graph queries |
| `mcp.js` | Model Context Protocol server and client endpoints |
| `memory.js` | Agent long-term memory CRUD (list, add, forget) |
| `model-quality.js` | Model quality scores, rankings, feedback submission |
| `multimodal.js` | Vision/describe, document extraction, OCR |
| `plugins.js` | Plugin marketplace, install/uninstall, sandbox execution |
| `rbac.js` | Role and permission management (RBAC) |
| `recipes.js` | Recipe CRUD and execution |
| `search.js` | Unified search across conversations and knowledge (inverted index) |
| `slack-discord.js` | Slack events and Discord interactions |
| `tasks.js` | Task planning endpoints |
| `teams.js` | Team membership, roles, activity log |
| `templates.js` | Workspace template management |
| `usage.js` | Usage tracking, analytics, cost estimation |
| `webhooks.js` | Webhook registration and management |
| `workflows.js` | Workflow engine CRUD, execution, run history |
| `workspaces.js` | Workspace CRUD, invite codes, membership |
| `v2/index.js` | API v2 route index |
| `v2/conversations.js` | API v2 conversations with structured errors |
| `v2/documents.js` | API v2 documents (renamed from "context" in v1) |
| `v2/recipes.js` | API v2 recipes |
| `v2/workspaces.js` | API v2 workspaces |

### lib/ -- 145 modules (grouped by category)

**Agent system (19 modules)**
`agent-loop.js`, `agent-loop-execute-tools.js`, `agent-tools.js`, `agent-defaults.js`, `agent-hooks.js`, `agent-iterations.js`, `agent-context-trim.js`, `agent-stagnation.js`, `agent-trajectory.js`, `agent-fetch-url.js`, `agent-memory.js`, `agent-memory-inject.js`, `agent-hitl-store.js`, `agent-policy.js`, `agent-run-control.js`, `agent-session.js`, `swarm.js`, `swarm-intent-v2.js`, `specialists.js`

**Auth and access control (9 modules)**
`auth.js`, `oauth.js`, `oidc.js`, `saml.js`, `sso.js`, `admin-auth.js`, `admin-ip-allowlist.js`, `scope-middleware.js`, `api-key-scopes.js`

**Storage (9 modules)**
`storage.js`, `json-path-store.js`, `storage-sqlite-kv.js`, `storage-postgres-kv.js`, `storage-replication.js`, `storage-eval.js`, `storage-optimizer.js`, `backup.js`, `migrations.js`

**Knowledge and RAG (10 modules)**
`knowledge-store.js`, `knowledge-chunking.js`, `knowledge-chunking-config.js`, `knowledge-url-fetch.js`, `knowledge-parsers.js`, `knowledge-graph.js`, `knowledge-graph-store.js`, `entity-extractor.js`, `embeddings.js`, `grounding.js`

**Search and indexing (2 modules)**
`search-index.js`, `conversation-search.js`

**Observability and tracing (9 modules)**
`metrics.js`, `tracing.js`, `tracing-spans.js`, `trace-recorder.js`, `trace-replay.js`, `otel-context.js`, `observability.js`, `log-sanitizer.js`, `error-reporting.js`

**Evaluation (7 modules)**
`eval-runner.js`, `eval-sets.js`, `eval-judge.js`, `eval-golden-trace.js`, `eval-staging-trace.js`, `eval-staging-traces.js`, `eval-agent-activity.js`

**Integrations (8 modules)**
`mcp-server.js`, `mcp-client.js`, `slack-bot.js`, `discord-bot.js`, `email-notifications.js`, `jira-integration.js`, `linear-integration.js`, `webhooks.js`

**Scheduling and automation (3 modules)**
`scheduler.js`, `schedules.js`, `notifications.js`

**Plugins (6 modules)**
`plugins-loader.js`, `plugin-sandbox.js`, `plugin-worker.js`, `plugin-marketplace.js`, `marketplace-manifest.js`, `marketplace-registry.js`

**Infrastructure (15 modules)**
`circuit-breaker.js`, `idempotency.js`, `leader-election.js`, `region-health.js`, `ab-router.js`, `llm-stream-sse.js`, `backend-fetch.js`, `realtime.js`, `realtime-redis.js`, `realtime-replay.js`, `quotas.js`, `ocr.js`, `pool-health.js`, `request-timeout.js`, `cache.js`

**Tool system (3 modules)**
`tool-chaining.js`, `tool-stream.js`, `tool-validation.js`

**Conversations (3 modules)**
`conversation-tree.js`, `conversation-export.js`, `conversation-sharing.js`

**Workspace and users (12 modules)**
`teams.js`, `workspace-lifecycle.js`, `workspace-templates.js`, `workspace-agent-settings.js`, `workspace-memory-tool.js`, `workspace-act-tools.js`, `workspace-fs-tools.js`, `workspace-migration.js`, `workspace-path-guard.js`, `workspace-rate-limit.js`, `usage-tracker.js`, `analytics.js`

**Model quality and routing (2 modules)**
`model-quality.js`, `smart-router.js`

**Workflow and collaboration (3 modules)**
`workflow-engine.js`, `collaboration.js`, `webhook-delivery.js`

**API versioning and errors (3 modules)**
`api-version.js`, `api-versioning.js`, `api-v2-errors.js`

**API keys and audit (7 modules)**
`api-keys.js`, `api-key-audit.js`, `audit-lifecycle.js`, `audit-query.js`, `audit-trim.js`, `audit-s3-archive.js`, `admin-data.js`

**HTTP and middleware (3 modules)**
`response-helpers.js`, `cache-middleware.js`, `error-middleware.js`

**Other (8 modules)**
`openapi-spec.js`, `openapi-generated.js`, `openapi-overrides.js`, `action-executor.js`, `analytics-engine.js`, `browser-agent-tools.js`, `federation.js`, `rbac.js`

**Validation, compliance, i18n (4 modules)**
`validate.js`, `compliance.js`, `i18n-errors.js`, `startup-checks.js`

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
| `tests/` | 143 test files (unit + integration + e2e) |
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
| `npm run eval:live` | Run eval sets against a live server |

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

143 test files across `tests/` (unit + integration) and `tests/e2e/` (Playwright). Tests use the Node.js built-in test runner (`node --test`) with supertest for HTTP assertions.

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
| `WORKSPACE_FILE_TOOLS` | Enable workspace file read tool (`1` to enable) |
| `WORKSPACE_ROOT` | Root directory for workspace file tools |
| `AGENT_TOOLS_ALLOWLIST` | Comma-separated tool names to expose (empty = all) |

## Agent system

### Agent modules (19 modules)

- **lib/agent-loop.js** -- Single-agent tool-call loop. The LLM calls tools, results feed back, loop continues until text response or max iterations.
- **lib/agent-loop-execute-tools.js** -- Tool execution within the agent loop, handles parallel tool calls.
- **lib/agent-tools.js** -- Tool definitions and execution. 21 tools registered (see below).
- **lib/agent-defaults.js** -- Default agent configuration (model, temperature, system prompt).
- **lib/agent-hooks.js** -- Lifecycle hooks (`beforeToolCall`, `afterToolCall`) for logging and validation.
- **lib/agent-iterations.js** -- Max iteration resolution and guard rails.
- **lib/agent-context-trim.js** -- Context window trimming to stay within token limits.
- **lib/agent-stagnation.js** -- Detects agent loops producing no progress and forces termination.
- **lib/agent-trajectory.js** -- Records and analyzes agent execution trajectories.
- **lib/agent-fetch-url.js** -- Allowlisted URL fetching for agent tools.
- **lib/agent-memory.js** -- Long-term agent memory storage and retrieval.
- **lib/agent-memory-inject.js** -- Injects relevant memories into agent context before each turn.
- **lib/agent-hitl-store.js** -- Human-in-the-loop approval store for sensitive tool calls.
- **lib/agent-policy.js** -- Agent execution policy enforcement.
- **lib/agent-run-control.js** -- Run lifecycle control (pause, resume, cancel).
- **lib/agent-session.js** -- Durable agent sessions with plan persistence.
- **lib/swarm.js** -- Multi-agent orchestration. Specialists run in parallel.
- **lib/swarm-intent-v2.js** -- Intent classification for swarm routing.
- **lib/specialists.js** -- Specialist agent definitions (researcher, executor, synthesizer).

### Agent tools (21 tools)

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
| `chain_tools` | Execute a sequence of tools where each receives the previous result |
| `search_knowledge_graph` | Search entities and relationships across documents |
| `update_agent_session_plan` | Save or update the durable plan for an agent session (conditional) |
| `workspace_read_file` | Read a file from the workspace filesystem (conditional, requires `WORKSPACE_FILE_TOOLS=1`) |
| `web_search` | Search the web via external search API (`SEARCH_API`) |
| `code_execute` | Execute code in a sandboxed environment (`AGENT_CODE_EXECUTE=1`) |
| `create_document` | Create a new knowledge document in the workspace |
| `schedule_task` | Schedule a task for future execution |
| `send_notification` | Send a notification to a user or channel |
| `query_database` | Run a read-only query against the storage backend (`AGENT_DB_QUERY=1`) |
| `browser_agent_tools` | Browser automation tools for web interaction |

## Knowledge graph

The knowledge graph (`lib/knowledge-graph.js`, `lib/knowledge-graph-store.js`, `lib/entity-extractor.js`) automatically extracts entities and relationships from knowledge base documents. Entities are typed (person, organization, concept, tool, technology, location, event) and linked by relationships. The `search_knowledge_graph` agent tool queries the graph to find connections between concepts across documents.

## Search index

`lib/search-index.js` provides an inverted index for full-text search across conversations and knowledge base documents. Used by `routes/search.js` for unified search and by `lib/conversation-search.js` for conversation-specific queries.

## Tool chaining

`lib/tool-chaining.js` and `lib/tool-stream.js` support multi-step tool execution pipelines. The `chain_tools` agent tool allows the LLM to compose tool sequences where each step receives the previous step's output, reducing round-trips for deterministic multi-step operations.

## Collaborative workspaces

`lib/collaboration.js` tracks active collaborators and activity within team workspaces. `routes/collaboration.js` exposes endpoints for listing collaborators and recent activity. Realtime presence is pushed via WebSocket.

## Model quality routing

`lib/model-quality.js` tracks per-model quality metrics (latency, error rate, user feedback). `lib/smart-router.js` uses quality scores to route requests to the best-performing backend/model combination. `routes/model-quality.js` exposes quality scores, rankings, and feedback submission endpoints.

## Workflow engine

`lib/workflow-engine.js` provides a DAG-based workflow execution engine. Workflows are defined as nodes with dependencies; the engine handles execution ordering, retries, and status tracking. `routes/workflows.js` exposes CRUD and execution endpoints.

## Webhook delivery

`lib/webhook-delivery.js` handles reliable webhook delivery with retries and dead-letter queue (DLQ). Failed deliveries are retried with exponential backoff before being moved to the DLQ for manual inspection.

## Database migrations

`lib/migrations.js` provides schema migration support for SQLite and PostgreSQL storage backends. Run migrations via the CLI `migrate` command or at server startup.

## API versioning

Routes are available at three tiers:
- `/api/` -- legacy (returns `X-API-Deprecated: use /api/v1/` header)
- `/api/v1/` -- current stable API
- `/api/v2/` -- next-generation API with structured errors (`lib/api-v2-errors.js`), stricter validation, and renamed resources (e.g., "documents" instead of "context")

`lib/api-version.js` and `lib/api-versioning.js` handle version negotiation and routing.

## Code style

- **ES modules** (`import`/`export`) everywhere. No CommonJS `require`.
- **No TypeScript.** Plain JavaScript only.
- **Minimal comments.** Code should be self-documenting.
- **Express middleware chains.** Routes use standard Express `(req, res, next)` patterns.
- **No build step** for the frontend. Vanilla JS served directly.

## Route structure

Routes are organized into modular files under `routes/` and mounted via `mountAllRoutes(app, deps)` in `server.js`. The `dualRegister` pattern mounts routes at both `/api/` (legacy) and `/api/v1/` (current). Legacy routes return the header `X-API-Deprecated: use /api/v1/`. The `routes/v2/` directory contains the next-generation API routes.

## Important patterns

- **mountAllRoutes:** Central function that wires all 37 route modules to the Express app with shared dependencies (storage, scheduler, realtime, etc.).
- **dualRegister:** Helper that registers Express routes at both `/api/` and `/api/v1/` paths simultaneously.
- **apiError:** Helper function for consistent JSON error responses with status codes and error codes.
- **apiV2Error:** Structured error responses for v2 API routes with machine-readable error codes.
- **Circuit breaker:** `lib/circuit-breaker.js` wraps backend calls. After consecutive failures (default 5), returns 503 immediately until cooldown expires. Configured via `CIRCUIT_BREAKER_FAILURES` and `CIRCUIT_BREAKER_COOLDOWN_MS`.
- **Storage scoping:** Storage is scoped by `userId` and `workspaceId`. Anonymous access uses `anonymous/default`.
- **Leader election:** `lib/leader-election.js` ensures only one instance runs scheduled jobs in multi-replica deployments.
- **A/B routing:** `lib/ab-router.js` routes requests to different backends based on experiment configuration.
- **Smart routing:** `lib/smart-router.js` routes to the best backend based on model quality metrics.
- **Cache middleware:** `lib/cache.js` and `lib/cache-middleware.js` provide response caching with configurable TTL.
- **Pool health:** `lib/pool-health.js` monitors connection pool health for database backends.
- **Request timeout:** `lib/request-timeout.js` enforces per-request timeout limits.

## What NOT to look for here

- Build instructions for Electron are in `docs/DESKTOP.md`.
- Deployment guides are in `docs/DEPLOYMENT.md` and `docs/DOCKER.md`.
- Operational runbooks are in `docs/RUNBOOK.md`.
- Plugin development guide is in `docs/PLUGINS.md` and `docs/PLUGIN_API.md`.
- Multi-region HA setup is in `docs/MULTI_REGION_HA.md`.
- Webhook configuration is in `docs/WEBHOOKS.md`.
