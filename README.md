# Siskel Bot

[![CI](https://github.com/hondoentertainment/SiskelBot/actions/workflows/ci.yml/badge.svg)](https://github.com/hondoentertainment/SiskelBot/actions/workflows/ci.yml) [![Docker](https://github.com/hondoentertainment/SiskelBot/actions/workflows/docker.yml/badge.svg)](https://github.com/hondoentertainment/SiskelBot/actions/workflows/docker.yml)

*Streaming assistant (OpenAI-compatible API for Ollama, vLLM, or OpenAI). Repository package name: `experimentagent`.*

> **New contributor?** Read [CONTRIBUTING.md](./CONTRIBUTING.md) and use the included [.devcontainer](./.devcontainer/) for a one-command setup.

Realtime streaming assistant proxy for Ollama, vLLM, or OpenAI. Node.js proxy that streams chat completions to clients with workspace management, agent orchestration, knowledge graphs, workflow automation, and integrations with GitHub, Vercel, Jira, Linear, Slack, and Discord.

## Architecture

```
                          +---------------------+
                          |    client/ (SPA)     |
                          |  Vanilla JS, no build|
                          +---------+-----------+
                                    |
                          HTTP / WebSocket
                                    |
                          +---------v-----------+
                          |     server.js        |
                          |  Express + Middleware |
                          +---------+-----------+
                                    |
                   +----------------+----------------+
                   |                |                 |
          +--------v------+ +------v-------+ +-------v--------+
          | routes/ (37)  | | lib/ (145)   | | routes/v2/ (5) |
          | v1 API routes | | Core modules | | v2 API routes  |
          +--------+------+ +------+-------+ +-------+--------+
                   |                |                 |
          +--------v----------------v-----------------v--------+
          |                    Backends                         |
          |  +----------+  +----------+  +-----------+         |
          |  |  Ollama   |  |   vLLM   |  |  OpenAI   |        |
          |  +----------+  +----------+  +-----------+         |
          +----------------------------------------------------+
                   |
          +--------v---------+
          |     Storage       |
          |  JSON / SQLite /  |
          |    PostgreSQL     |
          +------------------+
```

## Features

- **OpenAI-compatible API** -- `/v1/chat/completions` with streaming (SSE) and non-streaming modes
- **Multi-backend** -- Ollama, vLLM, and OpenAI backends with automatic failover
- **Agent mode** -- Single-agent tool-call loop with 21 built-in tools
- **Swarm mode** -- Multi-specialist orchestration (researcher, executor, synthesizer)
- **Knowledge base** -- Document storage, chunking, embeddings, semantic search
- **Knowledge graph** -- Automatic entity extraction and relationship mapping across documents
- **Unified search** -- Inverted index search across conversations and knowledge
- **Tool chaining** -- Multi-step tool pipelines without LLM round-trips
- **Workflow engine** -- DAG-based workflow execution with retries and status tracking
- **Model quality routing** -- Route requests to the best backend based on quality metrics
- **Collaborative workspaces** -- Team workspaces with roles, invite codes, activity feeds
- **RBAC** -- Role-based access control with granular permissions
- **Agent memory** -- Long-term memory injection across agent sessions
- **Agent sessions** -- Durable run grouping with plan persistence and cancellation
- **Conversation management** -- Branching, export, sharing, search
- **API versioning** -- v1 (stable), v2 (next-gen with structured errors)
- **Webhook delivery** -- Reliable delivery with retries and dead-letter queue
- **Database migrations** -- Schema migration support for SQLite and PostgreSQL
- **OAuth and SSO** -- GitHub, Google OAuth; OIDC and SAML support
- **MCP** -- Model Context Protocol server and client for tool interop
- **Plugins** -- Marketplace, sandboxed execution, custom actions
- **Scheduled recipes** -- Cron-based recipe execution with audit logging
- **Real-time sync** -- WebSocket presence and live notifications
- **Admin dashboard** -- Users, workspaces, quotas, usage, audit log
- **Observability** -- OpenTelemetry, Prometheus metrics, Grafana dashboards
- **PWA** -- Service worker, offline support, installable
- **Desktop app** -- Electron wrapper for Windows, macOS, Linux
- **CLI** -- 18 commands for chat, context, recipes, workspaces, and more
- **VS Code extension** -- Editor integration
- **143 tests** -- Unit, integration, e2e (Playwright), load, and eval tests

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

**OpenAI:**

```bash
# Set OPENAI_API_KEY in .env
cp .env.example .env
```

### 3. Start the proxy

```bash
# For Ollama (default for quick start)
BACKEND=ollama npm start

# Or copy .env.example to .env and configure
cp .env.example .env
npm start
```

Runs on `http://localhost:3000`.

### 4. Use the app

- **Web UI:** `http://localhost:3000`
- **API:** `POST http://localhost:3000/v1/chat/completions` (OpenAI-compatible)
- **CLI:** `npx . chat "Hello"` or `npm run cli -- chat "Your message"`
- **API docs:** `http://localhost:3000/api/docs` (Swagger UI)
- **Admin dashboard:** `http://localhost:3000/admin` (requires `ADMIN_API_KEY`)
- **Metrics:** `GET /metrics` (Prometheus format when `ENABLE_METRICS=1`)

### Desktop app (Electron)

```bash
npm install
npm run desktop
```

Default URL: `http://127.0.0.1:38447/`. See **[docs/DESKTOP.md](docs/DESKTOP.md)** for ports, OAuth redirects, and packaging notes.

**Windows installers (NSIS):**

```bash
npm run desktop:dist          # x64
npm run desktop:dist:arm64    # ARM64
npm run desktop:dist:all      # both
```

### Docker (self-hosted)

```bash
# Build and run with optional local Ollama
docker compose up -d

# Or build and run standalone
docker build -t siskelbot .
docker run -d -p 3000:3000 -e BACKEND=ollama -e OLLAMA_URL=http://host.docker.internal:11434 siskelbot
```

See **[docs/DOCKER.md](docs/DOCKER.md)** for details.

## Backends

| Backend | Env vars | Notes |
|---------|----------|-------|
| **Ollama** | `BACKEND=ollama`, `OLLAMA_URL` | Local, Windows-friendly |
| **vLLM** | `BACKEND=vllm`, `VLLM_URL` | High throughput, Linux/WSL |
| **OpenAI** | `BACKEND=openai`, `OPENAI_API_KEY` | Cloud API |

## CLI

Command-line client for chat, context, recipes, workspaces, and administration.

```bash
# Chat (streaming by default)
npx . chat "Hello"
npx . chat "Summarize this" --model gpt-4
npx . chat "Say ok" --no-stream

# Agent and swarm mode
npx . chat "Research this topic" --agent
npx . chat "Build and deploy" --swarm

# Context management
npx . context list
npx . context add --file ./notes.txt --title "Notes"

# Recipes
npx . recipes list
npx . recipes run "Build and Deploy"

# Workspaces
npx . workspace list
npx . workspace create --name "my-project"

# Search
npx . search "deployment guide"

# Administration
npx . admin
npx . health
npx . backup
npx . migrate

# Scheduled jobs and webhooks
npx . schedules
npx . webhooks

# Configuration
npx . config --url https://app.example.com
npx . init
npx . export
```

**Options:** `--url`, `--api-key`, `--workspace`, `--json`, `--no-stream`, `--model`, `--agent`, `--swarm`. Env: `SISKELBOT_URL`, `SISKELBOT_API_KEY`.

## Integrations

SiskelBot integrates with external services for issue tracking, notifications, and tooling.

| Integration | Env vars | Features |
|-------------|----------|----------|
| **GitHub** | `GITHUB_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Repos, issues, OAuth sign-in |
| **Vercel** | `VERCEL_TOKEN` | Deployments, projects |
| **Jira** | `JIRA_BASE_URL`, `JIRA_API_TOKEN`, `JIRA_USER_EMAIL` | Create/search issues |
| **Linear** | `LINEAR_API_KEY` | Create/search issues |
| **Slack** | `SLACK_BOT_TOKEN` | Bot events, notifications |
| **Discord** | `DISCORD_BOT_TOKEN` | Bot interactions, notifications |
| **Email** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Email notifications, digests |
| **MCP** | `MCP_SERVERS` | Model Context Protocol tool interop |

## Environment

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `BACKEND` | `ollama` | `ollama`, `vllm`, or `openai` |
| `VLLM_URL` | `http://localhost:8000` | vLLM server URL |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama server URL |
| `OPENAI_API_KEY` | -- | Required for OpenAI backend |
| `PORT` | `3000` | Proxy port |
| `API_KEY` | -- | Protects `/v1/chat/completions` |
| `ADMIN_API_KEY` | -- | Protects `/admin` and `/api/admin/*` |
| `USER_API_KEYS` | -- | Comma-separated `key:userId` pairs for user auth |
| `SESSION_SECRET` | -- | Secret for session cookies (required for OAuth) |
| `DATABASE_URL` | -- | PostgreSQL connection string |
| `STORAGE_BACKEND` | `json` | `json`, `sqlite`, or `postgres` |
| `STORAGE_PATH` | `./data` | Directory for JSON storage |
| `REDIS_URL` | -- | Redis connection string (caching/pubsub) |
| `ENABLE_METRICS` | -- | Set `1` to enable Prometheus metrics |
| `ENABLE_SCHEDULED_RECIPES` | -- | Set `1` to enable cron-based recipe execution |
| `WORKSPACE_FILE_TOOLS` | -- | Set `1` to enable workspace file read agent tool |
| `AGENT_TOOLS_ALLOWLIST` | -- | Comma-separated tool names to expose (empty = all) |

See `.env.example` for the full list of supported variables.

### Production on Vercel

Use `BACKEND=openai`, `OPENAI_API_KEY`, and `API_KEY` for the hosted chat API. For durable workspace, recipe, conversation, memory, and audit data on Vercel, set `STORAGE_BACKEND=postgres` with `DATABASE_URL`; the default JSON file storage is ephemeral in serverless deployments.

If scheduled recipes are enabled, also set `CRON_SECRET` and `ALLOW_RECIPE_STEP_EXECUTION=1`. If OAuth or SSO is enabled, set a strong `SESSION_SECRET` and the relevant provider credentials.

## Agent system

### Agent mode

When enabled, the assistant uses a tool-call loop: the LLM calls tools, results feed back, and the loop continues until the model responds with text or max iterations are reached. 21 built-in tools cover knowledge search, recipe execution, memory, knowledge graph queries, file access, and tool chaining.

### Swarm mode

Multi-specialist orchestration where researcher, executor, and synthesizer agents run in parallel. Intent detection routes queries to eligible specialists automatically.

### Agent memory

Long-term memory persists across agent sessions. Relevant memories are injected into context before each turn. Memory is scoped per workspace and managed via the memory API.

### Agent sessions

Durable agent sessions group tool-call runs, persist task plans (DAGs), and support pause/resume/cancel lifecycle control.

## Knowledge graph

Documents added to the knowledge base are automatically processed for entity extraction. Entities (people, organizations, concepts, tools, technologies) and their relationships form a queryable graph. The `search_knowledge_graph` agent tool traverses the graph to find connections between concepts.

## Workflow engine

DAG-based workflow definitions with dependency ordering, retries, and execution history. Create workflows via the API, trigger them manually or on schedule, and monitor run status.

## Testing

```bash
npm test                    # Run all tests
npm run test:coverage       # Tests with c8 coverage
npm run test:ci             # CI mode
npm run test:e2e            # Playwright end-to-end
npm run test:load           # Load/stress tests
npm run eval:ci             # Eval sets in CI mode
node --test tests/foo.test.js  # Single file
```

143 test files: unit, integration, e2e (Playwright), load, and eval tests. Coverage enforced in CI via `c8` (50% lines, 45% functions, 40% branches, 50% statements).

## Production (Vercel)

For Vercel deployment, use the OpenAI backend:

1. Connect your GitHub repo at [vercel.com](https://vercel.com).
2. Set env vars: `BACKEND=openai`, `OPENAI_API_KEY`, `API_KEY`.
3. Redeploy after adding variables.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full deployment guide including custom domains.

## Project layout

```
siskelbot/
├── server.js              # Express streaming proxy (1,073 lines)
├── routes/                # 37 route modules
│   ├── chat.js            # /v1/chat/completions
│   ├── agent-sessions.js  # Durable agent sessions
│   ├── analytics.js       # Real-time analytics
│   ├── collaboration.js   # Workspace collaboration
│   ├── knowledge.js       # Knowledge graph queries
│   ├── memory.js          # Agent long-term memory
│   ├── model-quality.js   # Model quality/ranking
│   ├── rbac.js            # Role-based access control
│   ├── search.js          # Unified search
│   ├── workflows.js       # Workflow engine
│   ├── v2/               # Next-gen API (v2)
│   │   ├── conversations.js
│   │   ├── documents.js
│   │   ├── recipes.js
│   │   └── workspaces.js
│   └── ...                # 24 more route modules
├── lib/                   # 145 core modules
│   ├── agent-*.js         # Agent system (19 modules)
│   ├── knowledge-*.js     # Knowledge and RAG (10 modules)
│   ├── workspace-*.js     # Workspace management (10 modules)
│   ├── eval-*.js          # Evaluation (7 modules)
│   ├── audit-*.js         # Audit trail (4 modules)
│   ├── storage-*.js       # Storage backends (5 modules)
│   └── ...                # 90 more modules
├── client/                # Vanilla JS SPA (no build step)
│   ├── index.html         # Chat UI
│   ├── admin.html         # Admin dashboard
│   ├── eval.html          # Eval runner
│   └── marketplace.html   # Plugin marketplace
├── bin/                   # CLI (18 commands)
├── tests/                 # 143 test files
├── docs/                  # Operational docs
├── scripts/               # Utility scripts
├── plugins/               # Plugin packs and manifests
├── electron/              # Desktop wrapper
├── vscode-extension/      # VS Code extension
├── sdk/                   # Generated client SDK
├── grafana/               # Grafana dashboard template
├── Dockerfile
├── docker-compose.yml
├── vercel.json
├── package.json
└── .env.example
```

## Documentation

| Document | Description |
|----------|-------------|
| [CLAUDE.md](CLAUDE.md) | AI assistant context and codebase conventions |
| [docs/GO_LIVE.md](docs/GO_LIVE.md) | Commercial go-live checklist (Stripe, plan enforcement, trials) |
| [docs/ROADMAP_71-80.md](docs/ROADMAP_71-80.md) | Phase 71 — next 10 product roadmap items |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel, Render, and custom domain deployment |
| [docs/DOCKER.md](docs/DOCKER.md) | Docker build, compose, and health checks |
| [docs/DESKTOP.md](docs/DESKTOP.md) | Electron desktop app build and packaging |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operational runbook and troubleshooting |
| [docs/PLUGINS.md](docs/PLUGINS.md) | Plugin development guide |
| [docs/PLUGIN_API.md](docs/PLUGIN_API.md) | Plugin API reference |
| [docs/WEBHOOKS.md](docs/WEBHOOKS.md) | Webhook configuration and event schema |
| [docs/MULTI_REGION_HA.md](docs/MULTI_REGION_HA.md) | Multi-region high availability setup |
| [docs/AGENT_MODE.md](docs/AGENT_MODE.md) | Agent and swarm mode details |
| [docs/TASK_SCHEMA.md](docs/TASK_SCHEMA.md) | Task plan JSON schema |
| [docs/TEST_PLAN.md](docs/TEST_PLAN.md) | Comprehensive test plan |
| [docs/SDKS.md](docs/SDKS.md) | TypeScript and Python SDK guide and publish steps |

## SDKs

Official client libraries live under [`sdk/`](sdk/):

| Language | Package | Path |
|----------|---------|------|
| TypeScript / Node.js | [`@siskelbot/sdk`](sdk/typescript/) | [`sdk/typescript/`](sdk/typescript/) |
| Python | [`siskelbot`](sdk/python/) | [`sdk/python/`](sdk/python/) |

Both ship with typed clients, SSE streaming, exponential-backoff retries on 5xx/429,
and configurable timeouts. See [docs/SDKS.md](docs/SDKS.md) for usage details and
publishing instructions (npm + PyPI).

## License

See [LICENSE](LICENSE) for details.
