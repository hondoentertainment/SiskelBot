# CLAUDE.md

Codebase conventions and context for AI assistants working on SiskelBot.

## Project overview

SiskelBot is a realtime streaming assistant proxy for Ollama, vLLM, and OpenAI. It is a Node.js Express server with a vanilla JS frontend (single-page app). The server proxies chat completions with streaming support, provides workspace/user management, task planning, agent orchestration, and integrations with GitHub and Vercel.

## Architecture

- **server.js** -- Main Express application. Mounts all routes, middleware, WebSocket upgrade handling, and server startup.
- **lib/** -- 82+ modules covering storage, auth, agents, analytics, circuit breaker, scheduling, webhooks, and more.
- **client/** -- Single-page application. Vanilla JS, no build step. Served as static files by Express. Key files: `index.html`, `templates.js`, `sw.js` (service worker), `admin.html`.
- **tests/** -- 45 test files using the Node.js built-in test runner and supertest.
- **docs/** -- Operational documentation (RUNBOOK.md, DEPLOYMENT.md, TASK_SCHEMA.md, TEST_PLAN.md, etc.).
- **scripts/** -- Utility and smoke-test scripts.
- **plugins/** -- Plugin configuration for extensible recipe step actions.

## Tech stack

- **Runtime:** Node.js, ES modules throughout (no TypeScript)
- **Server:** Express
- **Auth:** Passport (GitHub OAuth, Google OAuth), session cookies, API key auth
- **Storage:** JSON files (default, `data/` directory), SQLite KV (`STORAGE_BACKEND=sqlite`), PostgreSQL (`STORAGE_BACKEND=postgres` + `DATABASE_URL`)
- **Observability:** OpenTelemetry, Prometheus metrics (`GET /metrics` when `ENABLE_METRICS=1`)
- **Realtime:** WebSocket for live notifications and presence (Phase 33)
- **Testing:** Node.js built-in test runner (`node --test`) + supertest
- **PWA:** Service worker, web app manifest, offline support

## Key commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the server |
| `npm run dev` | Start with file watching (development) |
| `npm test` | Run all tests |
| `npm run test:ci` | Run tests in CI mode |
| `npm run lint` | Run ESLint |
| `npm run smoke-test:ci` | Run deployment smoke tests against a live server |
| `npm run test:e2e` | Run end-to-end tests |

## Testing

Tests use the Node.js built-in test runner (`node --test`) with supertest for HTTP assertions. All test files live in `tests/`.

Run a single test file:
```bash
node --test tests/foo.test.js
```

Run all tests:
```bash
npm test
```

Run with spec reporter:
```bash
node --test tests/**/*.test.js --test-reporter=spec
```

## Coverage

Coverage is enforced in CI via `c8` with thresholds defined in `.c8rc.json`:

| Metric | Minimum |
|--------|---------|
| Lines | 50% |
| Functions | 45% |
| Branches | 40% |
| Statements | 50% |

Check coverage locally:
```bash
npm run test:coverage
```

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

## Code style

- **ES modules** (`import`/`export`) everywhere. No CommonJS `require`.
- **No TypeScript.** Plain JavaScript only.
- **Minimal comments.** Code should be self-documenting.
- **Express middleware chains.** Routes use standard Express `(req, res, next)` patterns.
- **No build step** for the frontend. Vanilla JS served directly.

## Route structure

Routes are defined in `server.js` and organized into Express Router middleware. The `dualRegister` pattern mounts routes at both `/api/` (legacy) and `/api/v1/` (current). Legacy routes return the header `X-API-Deprecated: use /api/v1/`.

## Agent system

- **lib/agent-loop.js** -- Single-agent tool-call loop. The LLM calls tools, results feed back, loop continues until text response or max iterations.
- **lib/swarm.js** -- Multi-agent orchestration. Specialists (researcher, executor, synthesizer) run in parallel.
- **lib/agent-tools.js** -- Tool definitions (`search_context`, `list_context`, `get_recipe`, `execute_step`).
- **lib/agent-defaults.js** -- Default agent configuration.
- **lib/agent-hooks.js** -- Lifecycle hooks for agent execution.

## Important patterns

- **dualRegister:** Helper that registers Express routes at both `/api/` and `/api/v1/` paths simultaneously. Used throughout server.js.
- **apiError:** Helper function for consistent JSON error responses with status codes and error codes.
- **Circuit breaker:** `lib/circuit-breaker.js` wraps backend calls. After consecutive failures (default 5), returns 503 immediately until cooldown expires. Configured via `CIRCUIT_BREAKER_FAILURES` and `CIRCUIT_BREAKER_COOLDOWN_MS`.
- **Storage scoping:** Storage is scoped by `userId` and `workspaceId`. Anonymous access uses `anonymous/default`.

## What NOT to look for here

- Build instructions for Electron are in `docs/DESKTOP.md`.
- Deployment guides are in `docs/DEPLOYMENT.md` and `docs/DOCKER.md`.
- Operational runbooks are in `docs/RUNBOOK.md`.
