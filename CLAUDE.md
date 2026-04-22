# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

SiskelBot is a realtime streaming assistant proxy that fronts Ollama, vLLM, or OpenAI. It is a Node.js Express server plus a vanilla-JS SPA. The server exposes an OpenAI-compatible `/v1/chat/completions` with SSE streaming and layers on workspace/user management, agent orchestration (single-agent tool loop + multi-specialist swarm), a knowledge base with embeddings and a knowledge graph, a DAG workflow engine, plugin marketplace, webhooks, RBAC, OAuth/SSO, audit, and integrations (GitHub, Vercel, Jira, Linear, Slack, Discord, MCP).

## Commands

```bash
npm start                     # Start server (runs prestart: legacy client bundle)
npm run dev                   # Start with --watch
npm run lint                  # scripts/syntax-check.mjs + eslint
npm test                      # scripts/run-tests.mjs (Node built-in runner + supertest)
npm run test:ci               # CI mode with c8 coverage + critical-path gate
npm run test:coverage         # c8 coverage, then critical-path gate
npm run test:e2e              # Playwright (see playwright.config.js)
npm run test:load             # scripts/load-test.mjs
npm run eval:ci               # Eval sets in CI (regression gate)
npm run smoke-test:ci         # Smoke against live server
npm run openapi:generate      # Regenerate OpenAPI spec from route metadata
npm run build:client          # Bundle client via esbuild
npm run build:sdk             # Generate client SDK from OpenAPI spec (scripts/generate-sdk.mjs)

# Single test file
node --test tests/foo.test.js
```

CI pipeline is `npm run ci` (= `lint` + `test:ci`). Coverage thresholds live in `.c8rc.json` (50% lines/statements, 45% functions, 40% branches), enforced alongside `scripts/check-critical-coverage.mjs`.

## Architecture

### Request flow

`server.js` bootstraps Express with helmet/CORS/compression/rate-limit/session/passport, initializes storage and plugins, then calls `mountAllRoutes(app, deps)` from `routes/index.js`. `deps` carries shared helpers (auth middleware, `apiError`, `dualRegister`, storage, scheduler, realtime hooks, rate limiters) into every route module. A `http.createServer` instance wraps the app so WebSocket upgrades (`routes/realtime-ws.js`, `lib/realtime.js`) can share the port.

Route modules live under `routes/` and are discovered through `routes/index.js` — **use that file as the source of truth for what routes exist**; the list grows often. `routes/v2/` holds next-gen API variants. Do not enumerate routes in docs by hand.

### `dualRegister` and API versioning

Legacy v1 routes are registered at both `/api/` and `/api/v1/` via the `dualRegister` helper; the legacy path also sets `X-API-Deprecated: use /api/v1/`. v2 routes (under `/api/v2/`) use structured errors from `lib/api-v2-errors.js` (`apiV2Error`) with machine-readable codes and stricter validation, and rename some resources (e.g. `context` → `documents`). `lib/api-version.js` / `lib/api-versioning.js` handle negotiation. When adding a new v1 endpoint, go through `dualRegister` + `apiError`; for v2, use `apiV2Error`.

### Storage abstraction

`lib/storage.js` is the single entry point for persistence. Backend is selected by env:

| Backend | Config |
|---|---|
| JSON files (default) | `STORAGE_PATH=./data` |
| SQLite KV | `STORAGE_BACKEND=sqlite` |
| PostgreSQL | `STORAGE_BACKEND=postgres` + `DATABASE_URL` |

Data is always scoped by `userId` + `workspaceId`; anonymous callers use `anonymous/default`. Use `resolveStorageUserId` (from `lib/teams.js`) when you need to map an authenticated request to the storage tenant — don't read `req.user.id` directly. `lib/migrations.js` runs schema migrations for SQLite/Postgres at startup and via the CLI `migrate` command.

### Agent system

Two execution modes:

- **Single-agent loop** (`lib/agent-loop.js`): the LLM emits tool calls, `lib/agent-loop-execute-tools.js` runs them (parallel where possible), results feed back, loop continues until text output or max iterations. Iteration budget is resolved by `lib/agent-iterations.js`; `lib/agent-stagnation.js` kills no-progress loops; `lib/agent-context-trim.js` keeps messages under the model window.
- **Swarm** (`lib/swarm.js` + `lib/swarm-intent-v2.js` + `lib/specialists.js`): intent classification routes to specialists (researcher/executor/synthesizer) that run in parallel, then synthesize.

Tool registry lives in `lib/agent-tools.js` — **that file is authoritative for the tool list, schemas, and gating env vars** (`AGENT_CODE_EXECUTE`, `AGENT_DB_QUERY`, `WORKSPACE_FILE_TOOLS`, `SEARCH_API`). `AGENT_TOOLS_ALLOWLIST` narrows the exposed set. Client-declared tools are intersected with the allowlist via `intersectClientToolsWithAllowlist`.

Durable runs: `lib/agent-session.js` persists session plans; `lib/agent-run-control.js` supports pause/resume/cancel; `lib/agent-hitl-store.js` gates sensitive calls on human approval; `lib/agent-memory.js` + `lib/agent-memory-inject.js` hold long-term memory injected per turn; `lib/agent-trajectory.js` records execution for replay and branching.

### Knowledge and search

`lib/knowledge-store.js` handles document storage, chunking (`lib/knowledge-chunking.js`), and embeddings (`lib/embeddings.js` + `lib/embedding-cache.js`). `lib/knowledge-graph.js` + `lib/knowledge-graph-store.js` + `lib/entity-extractor.js` build a typed entity/relationship graph from documents, exposed via the `search_knowledge_graph` agent tool. `lib/search-index.js` is a shared inverted index used by `routes/search.js` and `lib/conversation-search.js`.

### Infrastructure primitives

Backend calls to LLM providers go through `lib/circuit-breaker.js` (open after `CIRCUIT_BREAKER_FAILURES` consecutive failures, half-open after `CIRCUIT_BREAKER_COOLDOWN_MS`), and routing is chosen by `lib/ab-router.js` (experiment config) or `lib/smart-router.js` (model quality metrics from `lib/model-quality.js`). `lib/leader-election.js` ensures scheduled jobs run on exactly one replica. `lib/webhook-delivery.js` does retried delivery with a DLQ. `lib/cache.js` + `lib/cache-middleware.js` provide response caching. SSE streaming for LLM responses goes through `lib/llm-stream-sse.js` / `lib/backend-fetch.js`.

Observability: `lib/tracing.js` (OpenTelemetry, enable via standard OTEL env vars), `lib/metrics.js` (Prometheus at `GET /metrics` when `ENABLE_METRICS=1`), `lib/log-sanitizer.js` (always run PII scrubbing before logging request bodies), `lib/error-reporting.js`.

### Client

`client/` is vanilla JS served as static files — **no build step is required for development**. There is an esbuild bundle (`npm run build:client`) and a legacy bundle (`scripts/build-client-legacy.mjs`, run automatically as `prestart`). When editing client code, prefer editing the source directly; the bundles are regenerated on start.

### CLI

`bin/siskelbot.js` is the `siskelbot` command. It talks to a running server over HTTP and respects `SISKELBOT_URL` / `SISKELBOT_API_KEY`. Full command list is in the CLI's own `--help` and in `README.md`.

## Code conventions

- **ES modules only** (`import`/`export`). No CommonJS `require`. Files are `.js` with `"type": "module"` in package.json; Electron-side CommonJS lives in `electron/*.cjs`.
- **No TypeScript.** `jsconfig.json` and `tsconfig.json` exist for editor hints only — do not add `.ts` files.
- **No new build tooling for client code.** If you touch `client/`, keep it plain JS that runs in the browser directly.
- **Imperative commit messages** ("Add X", "Fix Y"). Phase numbers are sometimes used (e.g. `Phase 33: Add WebSocket presence tracking`) — match what's already on the branch.
- **Minimal comments.** The repo prefers self-documenting code.

## Sources of truth (don't duplicate these)

When you need a current list, read the source instead of relying on this file:

| Topic | Authoritative source |
|---|---|
| Routes mounted | `routes/index.js` |
| Agent tools + gating | `lib/agent-tools.js` |
| Environment variables | `.env.example` |
| CLI commands | `bin/siskelbot.js` and its `--help` |
| OpenAPI schema | `lib/openapi-spec.js` (regen via `npm run openapi:generate`) |
| Coverage thresholds | `.c8rc.json` |

## Deep-dive docs

Deployment, Docker, desktop packaging, plugins, webhooks, multi-region HA, agent mode internals, and the task-plan schema each have dedicated files under `docs/` (see `README.md` for the index). Don't recreate their content here.
