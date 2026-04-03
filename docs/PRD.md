# Siskel Bot – Product Requirements Document

**Version:** 1.0  
**Last updated:** March 2026

---

## 1. Executive Summary

Siskel Bot is a production-grade, realtime streaming assistant proxy that connects clients to LLM backends (Ollama, vLLM, OpenAI). It provides chat completions, agentic autonomy with tools, multi-agent swarms, task planning, knowledge search, scheduled recipes, and team collaboration—all behind a single OpenAI-compatible API.

### Vision

Enable developers and teams to build AI-powered workflows with:

- **Flexibility** – Local (Ollama/vLLM) or cloud (OpenAI)
- **Production readiness** – Security, observability, fault tolerance
- **Extensibility** – Plugins, webhooks, custom actions
- **Collaboration** – Workspaces, teams, quotas, activity feeds

---

## 2. Goals & Success Metrics

| Goal | Success Metric |
|------|----------------|
| **Reliability** | 99.9% uptime (excluding backend outages); circuit breaker prevents cascading failures |
| **Security** | API key protection, CSP, CORS, log sanitization; no secrets in logs |
| **Observability** | Prometheus metrics, structured logs, X-Request-Id, health probes |
| **Scalability** | Per-user rate limits, per-workspace quotas, agent swarm parallelism |
| **Developer experience** | OpenAI-compatible API; Swagger docs; eval harness; smoke tests |

---

## 3. User Personas

| Persona | Description | Key needs |
|---------|-------------|-----------|
| **Solo developer** | Local dev, Ollama/vLLM | Quick setup, low latency, optional API key |
| **Team lead** | Multi-user, quotas | Workspaces, user auth, admin dashboard |
| **Enterprise** | Production, OpenAI | API keys, CORS, metrics, circuit breaker |
| **Integrator** | CI/CD, automation | Recipes, webhooks, eval harness |
| **AI engineer** | Model evaluation | Eval sets, semantic search, embeddings |

---

## 4. Feature Requirements

### 4.1 Core Chat & Completions

- **OpenAI-compatible API** – `POST /v1/chat/completions` with streaming
- **Backends** – Ollama, vLLM, OpenAI (configurable)
- **API key** – Optional `API_KEY` protects chat endpoint
- **Rate limiting** – Per-IP or per-user when auth configured

### 4.2 Agent Mode

- **Tools** – `search_context`, `list_context`, `get_recipe`, `execute_step`
- **Loop** – LLM calls tools; results fed back; repeat until done or max iterations
- **Safety** – `ALLOW_RECIPE_STEP_EXECUTION=1` + client toggle for step execution
- **Parallel tool execution** – Multiple tool calls run concurrently

### 4.3 Agent Swarm

- **Specialists** – Researcher (search/list context), Executor (run steps, get recipe), Synthesizer (combine outputs)
- **Intent detection** – Keyword-based routing to eligible specialists
- **Parallel execution** – Specialists run in parallel; synthesizer combines
- **Model routing** – Per-specialist model override (e.g. researcher → gpt-4o-mini)

### 4.4 Task Planning

- **Plan generation** – `POST /v1/tasks/plan` returns structured JSON
- **Schema** – `type`, `name`, `steps`, `requiresApproval`
- **Execution** – `execute_step` tool runs build/deploy/copy actions

### 4.5 Knowledge & RAG

- **Indexing** – `POST /api/knowledge/index` (keyword + optional embeddings)
- **Search** – Keyword and semantic (`?semantic=1`) search
- **Embeddings** – OpenAI `text-embedding-3-small` when `OPENAI_API_KEY` set

### 4.6 Workspaces & Multi-Tenancy

- **Workspaces** – Per-user, personal or team
- **Teams** – Invite codes, roles (admin, member, viewer), activity feed
- **Quotas** – Per-workspace token limits; admin override

### 4.7 Auth

- **API keys** – `USER_API_KEYS` (key:userId:scopes), `API_KEY` (deployment)
- **OAuth** – GitHub, Google via Passport
- **Scopes** – read, write, admin, embed

### 4.8 Scheduling & Automation

- **Schedules** – Cron expressions per recipe
- **Cron** – Local node-cron or Vercel Cron
- **Webhooks** – Event notifications (recipe_executed, swarm_completed, etc.)

### 4.9 Admin & Operations

- **Admin dashboard** – Users, workspaces, quotas, health, audit log
- **Backup/restore** – ZIP archives of data/
- **Eval harness** – Run eval sets against chat/task APIs

### 4.10 Production Hardening

- **Graceful shutdown** – SIGTERM/SIGINT
- **Health probes** – `/health/live`, `/health/ready`
- **CSP** – Content-Security-Policy (report-only by default)
- **Log sanitization** – No secrets in logs
- **Circuit breaker** – Fail fast after N backend failures
- **Error reporting** – Webhook for uncaught errors

---

## 5. Phase Roadmap

### Implemented (Phases 1–44)

| Phase | Name |
|-------|------|
| 2 | Profiles, templates, searchable history |
| 3 | Task planning (plan generation) |
| 4 | Toolchain integration (GitHub, Vercel) |
| 7 | Monitoring config |
| 9 | Recipe execution & audit |
| 10 | Storage (context, recipes, conversations) |
| 13 | Usage tracking & budget alerts |
| 14 | User auth & workspaces |
| 15 | Agent mode (tools, loop) |
| 16 | Scheduled recipes |
| 17 | Plugins |
| 18 | Analytics dashboard |
| 19 | OAuth (GitHub, Google) |
| 20 | PWA & offline |
| 21 | Per-user & per-workspace quotas |
| 22 | Webhooks |
| 23 | API versioning (/api/v1/) |
| 24 | Backup & restore |
| 25 | Admin dashboard |
| 26 | Accessibility |
| 27 | Notification center |
| 28 | Embeddings & semantic search |
| 29 | Multi-tenant teams |
| 30 | API key scopes |
| 31 | Internationalization (i18n) |
| 32 | Evaluation harness |
| 33 | Real-time sync (WebSocket, presence) |
| 34 | Production hardening |
| 35 | Content Security Policy |
| 36 | Log sanitization |
| 37 | Backend circuit breaker |
| 38 | Error reporting webhook |
| 39 | Deployment smoke tests |
| 40 | Metrics & Prometheus |
| 41 | Request timeouts & retry |
| 42 | Granular CORS |
| 43 | Swarm model routing |
| 44 | Response compression |
| — | Agent swarm |

### Implemented (Phases 50–54)

| Phase | Name |
|-------|------|
| 50 | Storage abstraction — optional SQLite KV (`STORAGE_BACKEND=sqlite`, `better-sqlite3`) |
| 51 | Agent final response chunked SSE (`STREAM_AGENT_FINAL=1`, `AGENT_STREAM_CHUNK_SIZE`) |
| 52 | Audit log retention (`AUDIT_MAX_ENTRIES`, `AUDIT_RETENTION_DAYS`) |
| 53 | Backend fallback (`FALLBACK_BACKEND`) on 5xx/429 or connection failure |
| 54 | OpenTelemetry optional (`OTEL_ENABLED=1`, OTLP HTTP exporter) |

### Implemented (Phases 55–59) — Agent quality

| Phase | Name |
|-------|------|
| 55 | Strict tool validation — invalid JSON/args return repair hints; `TOOL_VALIDATION_STRICT=0` disables |
| 56 | Golden-trace eval — `target: "trace"` + `expectedToolSequence` / `expectedToolNames` / `expectedToolCalls` (no live LLM) |
| 57 | Grounding / citations — `AGENT_REQUIRE_CITATIONS=1` injects system guidance; `X-Agent-Citations-Missing` when answer lacks cites |
| 58 | Stagnation stop — identical tool fingerprints across consecutive iterations; `AGENT_STAGNATION_STOP=0` disables |
| 59 | Agent trajectory — `X-Agent-Run-Id`, SSE `agent_activity.trajectory`, `GET /api/agent/trajectory/:runId` (in-memory TTL) |
| 60 | Default agent system — `AGENT_DEFAULT_SYSTEM` merged into agent + swarm LLM messages; `GET /config` → `agentDefaultSystemSet` |
| 61 | Per-workspace agent instructions — `defaultSystemPrompt` in `agent-settings.json`; `GET`/`PUT /api/workspaces/:id/agent-settings` |
| 62 | Approved workspace memory — `memorySnippets[]` merged as a system section after env + workspace prompt; team paths use `resolveStorageUserId` |
| 63 | Client Settings hint — when `agentDefaultSystemSet`, show non-leaking notice that deployment default agent text is active |
| 64 | Workspace agent UI — Settings panel loads/saves `GET`/`PUT .../agent-settings` (i18n: en/es/fr/de) |
| 65 | Eval expansion — `data/eval-sets/example.json` golden-trace cases (`expectedToolSequence`, `expectedToolNames`, `expectedToolCalls`) |
| 66 | Postgres KV storage — `STORAGE_BACKEND=postgres` + `DATABASE_URL`; `storage_kv` path keys for `lib/storage.js` (async API) |
| 67 | OTEL auto-instrumentation — `@opentelemetry/instrumentation-http` + `instrumentation-undici` (global `fetch`); `OTEL_AUTO_INSTRUMENT=0` disables |
| 69 | Deeper OpenTelemetry — `instrumentation-pg`, SQLite KV spans, request attributes (`siskel.user_id_hash`, `siskel.workspace_id`), head-based sampling envs, optional Prometheus histogram exemplars (`OTEL_PROMETHEUS_EXEMPLARS`) |

### Implemented (Phases 68, 70–77) — production & platform

| Phase | Name |
|-------|------|
| 68 | Durable tenant modules — schedules, teams, webhooks, notifications, quotas, usage, API keys, OAuth state, agent-settings, etc. on `json-path-store` (Postgres/SQLite/file); backup snapshot coverage |
| 70 | Audit S3 archival — `lib/audit-s3-archive.js`; `POST /api/admin/audit/archive-s3`, `GET /api/admin/audit/archive-status`; optional local trim after upload |
| 71 | Durable agent trajectories — `AGENT_TRAJECTORY_DURABLE`; persist via json-path-store + `agent-trajectories.json` |
| 72 | RAG v2 — chunking (`KNOWLEDGE_CHUNKING`), `POST /api/v1/knowledge/reindex`, `POST /api/v1/knowledge/fetch` + `KNOWLEDGE_URL_ALLOWLIST`; see `docs/RAG_PIPELINE_V2.md` |
| 73 | Swarm routing v2 — `lib/swarm-intent-v2.js`; `SWARM_INTENT_MODE=embedding` optional |
| 74 | Workspace lifecycle — `GET /api/v1/workspaces/:id/export`, `DELETE /api/v1/workspaces/:id` (owner, confirm); `lib/workspace-lifecycle.js` |
| 75 | API hardening — OpenAPI deprecation policy; idempotency keys on `POST /workspaces`; `examples/sdk-starter.ts` |
| 76 | Multi-region / HA — operator design note `docs/MULTI_REGION_HA.md` |
| 77 | Plugin pinning — `PLUGINS_CONFIG_SHA256`; curated `data/plugin-registry.json`; `docs/PLUGINS.md` |
| 78 | Parallel swarm specialists — `SWARM_PARALLEL_AGENTS`, `agentOptions.parallelAgents`, `resolveSwarmSpecialistNames`; headers `X-Swarm-Parallel`, `X-Swarm-Intent-Mode`; Settings UI + i18n |
| 79 | Tool-choice policy — `agentOptions.toolChoice`, `requiredToolSequence` (first tool forced on iteration 1); single-agent + swarm specialist loops |
| 80 | Agent run budgets — `MAX_AGENT_TOOL_CALLS`, `AGENT_MAX_WALL_MS`; `X-Agent-Truncated` (`wall_clock`, `tool_budget`, `max_iterations`) |
| 81 | Structured outputs — `agentOptions.responseFormat` merged into LLM requests (OpenAI-compatible when backend supports) |
| 82 | Tool-writable memory — `remember_workspace_fact`, `list_workspace_memory`; audit `agent_remember_workspace`; uses workspace agent-settings caps |
| 83 | Plan–reflect — `AGENT_PLAN_REFLECT=1` appends one non-tool reflection LLM paragraph after successful agent completion |
| 84 | Configurable specialists — `data/specialists-extra.json` or `SPECIALISTS_EXTRA_PATH`; merge/override `lib/specialists.js` |
| 85 | `fetch_allowed_url` tool — `AGENT_FETCH_ALLOWLIST` or `KNOWLEDGE_URL_ALLOWLIST`; `lib/agent-fetch-url.js` + `fetchTextFromUrlWithEntries` |
| 86 | `STREAM_SWARM_SYNTH` — stream synthesizer via `lib/llm-stream-sse.js`; `synthesisDeferred` in `runSwarm` return |
| 87 | Eval judge — `target: "judge"`, `judgeRubric`; `lib/eval-judge.js` |
| 88 | Agent hooks — `AGENT_HOOKS_MODULE` ESM; `beforeToolCall` / `afterToolCall` in `lib/agent-hooks.js` |
| 89 | Deployment tool allowlist — `AGENT_TOOLS_ALLOWLIST`; filters `getToolsSchema` / `getToolsForNames`; intersects client `tools`; `runTool` rejects disallowed names; `GET /config` → `agentToolsAllowlist` |
| 90 | Client swarm roster — `SWARM_CLIENT_SPECIALISTS=1`, `SWARM_MAX_SPECIALISTS` (cap 1–12); `agentOptions.swarmSpecialists`; `resolveSwarmSpecialistNames` returns `rosterSource`; headers `X-Swarm-Roster-Source`, webhook `rosterSource`; `GET /config` → `swarmClientSpecialistsAllowed`, `swarmMaxSpecialists`, `swarmSelectableSpecialists`; Settings checkboxes + payload |
| 91 | Swarm specialist allowlist — `SWARM_SPECIALISTS_ALLOWLIST` (comma-separated); intersects LLM swarm resolution (client / parallel / intent), `GET /config` → `swarmSpecialistsAllowlist` + filtered `swarmSelectableSpecialists` / `legacySwarmSpecialists`; `POST /v1/swarm` body specialists filtered |
| 92 | Client-tunable iteration cap — `agentOptions.maxIterations` (integer ≥ 1) clamped to `MAX_AGENT_ITERATIONS`; `AGENT_MAX_ITERATIONS_IGNORE_CLIENT=1` disables client override; header `X-Agent-Max-Iterations`; `GET /config` → `agentMaxIterationsCeiling`, `agentMaxIterationsClientTunable` |
| 93 | Eval live agent/swarm chat — `chatRequestDefaults` and per-case overrides (`agentMode`, `swarmMode`, `agentOptions`, `chatRequest`, etc.) merged into `POST /v1/chat/completions`; SSE responses parsed for assistant text + `agent_activity`; `lib/eval-runner.js` |
| 94 | Eval harness schema docs — `docs/RUNBOOK.md` Phase 32 documents agent activity fields, skip cases, and API response shape (`skipped`, per-result `agentActivityHint`) |
| 95 | Eval example sets — skippable live-agent templates in `data/eval-sets/example.json` and `data/eval-sets/agent-outcome-examples.json` for staging/manual runs |
| 96 | Eval UI — `/eval` shows skipped cases distinctly; optional **Activity** column from `agentActivityHint`; summary uses `passed` (non-skipped passes) and `skipped` count |

### Planned (Phases 97–116) — Desktop Application

| Phase | Name |
|-------|------|
| 97 | **Native menu bar** — File (New Chat, Open Data Folder, Quit), Edit (Undo/Redo/Cut/Copy/Paste), View (Zoom In/Out/Reset, Toggle DevTools, Reload), Help (About, Check for Updates); macOS app menu; accelerators; `electron/menu.cjs` |
| 98 | **System tray** — Minimize-to-tray on close (`DESKTOP_CLOSE_TO_TRAY=1`); tray icon with context menu (Show/Hide, New Chat, Quit); badge/dot for unread notifications; `electron/tray.cjs` |
| 99 | **macOS & Linux builds** — electron-builder targets: DMG + ZIP for macOS (universal binary), AppImage + deb + rpm for Linux; CI matrix in `release.yml`; code-signing env vars for macOS (`CSC_LINK`, `CSC_KEY_PASSWORD`); Linux `.desktop` file and icons |
| 100 | **Auto-updater** — `electron-updater` with GitHub Releases as update source; check on launch + periodic (configurable `DESKTOP_UPDATE_INTERVAL_HOURS`); user prompt before install; `electron/updater.cjs`; update menu items (Check for Updates, Release Notes) |
| 101 | **IPC bridge & preload** — `electron/preload.cjs` exposes `window.siskelDesktop` via `contextBridge`: `getVersion()`, `getPlatform()`, `onDeepLink()`, `showNativeNotification()`, `setTrayBadge()`, `getAutoLaunch()`, `setAutoLaunch()`; strict `contextIsolation` + `sandbox: true` |
| 102 | **Native notifications** — Desktop push via Electron `Notification` API; server WebSocket events (`new_message`, `agent_complete`, `swarm_complete`, `schedule_fired`) trigger native toasts; click-to-focus; notification preferences in Settings (per-event toggle); respects OS Do Not Disturb |
| 103 | **Deep linking & protocol handler** — Register `siskelbot://` protocol; handle `siskelbot://chat?prompt=...`, `siskelbot://workspace/<id>`, `siskelbot://recipe/<name>`; macOS `open-url` + Windows registry; Linux `.desktop` MimeType; single-instance forwards URL to existing window |
| 104 | **Keyboard shortcuts (global & local)** — Global hotkey to summon window (`DESKTOP_GLOBAL_HOTKEY`, default `CmdOrCtrl+Shift+S`); local shortcuts: `Ctrl+N` new chat, `Ctrl+K` command palette, `Ctrl+,` settings, `Ctrl+L` clear chat, `Ctrl+Tab`/`Ctrl+Shift+Tab` cycle conversations; `electron/shortcuts.cjs` |
| 105 | **Window state persistence** — Remember window bounds (x, y, width, height), maximized state, and active display across restarts; `electron-window-state` or custom JSON in `userData`; multi-monitor safe (clamp to visible screen on restore) |
| 106 | **Local model manager** — UI panel to browse, pull, and delete Ollama models directly from the desktop app; `GET /api/desktop/models` proxies `ollama list`; `POST /api/desktop/models/pull` streams progress via SSE; delete confirmation; shows model size, quantization, last used; auto-detect Ollama install path |
| 107 | **File drag-and-drop & native dialogs** — Drag files onto chat window to attach (PDF, images, text); native `dialog.showOpenDialog` for file picker; dropped files auto-indexed into knowledge base or attached as context; progress indicator for large PDFs; `electron/file-handler.cjs` |
| 108 | **Startup on login** — Auto-launch option in Settings; `app.setLoginItemSettings()` for macOS/Windows; Linux `~/.config/autostart/*.desktop`; start minimized to tray option (`DESKTOP_START_MINIMIZED`); `electron/auto-launch.cjs` |
| 109 | **Theming & appearance** — Light/Dark/System theme with `nativeTheme` sync; accent color picker; custom CSS injection for advanced users (`userData/custom.css`); title bar style: native (default) or frameless with custom title bar (`DESKTOP_FRAMELESS=1`); vibrancy/mica material on macOS/Windows 11 |
| 110 | **Offline mode & embedded backend** — Detect when no network available; bundle a small GGUF model (e.g. Phi-3-mini) with optional download-on-first-run; `electron/embedded-llm.cjs` spawns `llama.cpp` server or Ollama as fallback; seamless switch between local-offline and cloud backends; status bar indicator (Online/Offline/Local) |
| 111 | **Multi-window & tab support** — Open conversations in separate windows (`Ctrl+Shift+N`); tab bar for multiple chats within one window; drag tabs between windows; each tab has independent chat state; workspace switcher in sidebar; `electron/window-manager.cjs` tracks all windows |
| 112 | **Desktop plugin host** — Plugins can register native capabilities: custom tray menu items, global shortcuts, file-type handlers, menu bar entries; `electron/plugin-bridge.cjs` mediates between renderer plugins and main process; sandboxed IPC channel per plugin; manifest declares `desktop` capabilities |
| 113 | **Crash reporting & diagnostics** — `electron.crashReporter` with local minidump collection; `Help > Diagnostic Report` bundles: app version, OS, Node version, last 500 log lines, server health, memory usage, active backend; export as ZIP for support; opt-in anonymous telemetry (`DESKTOP_TELEMETRY=1`) |
| 114 | **Spotlight / Quick Launch** — `Ctrl+K` or `Cmd+K` opens a fuzzy-search command palette overlay: switch workspace, open conversation, run recipe, search knowledge, toggle agent/swarm mode, open settings, pull model; extensible by plugins; recent items + frecency ranking; `client/js/command-palette.js` |
| 115 | **Desktop CI & release pipeline** — GitHub Actions matrix: Windows x64/arm64, macOS x64/arm64 (universal), Linux x64/arm64; code-sign and notarize macOS builds; Windows Authenticode signing; auto-publish to GitHub Releases with changelogs; Homebrew cask formula; Snapcraft / Flatpak manifests; `scripts/desktop-release.mjs` |
| 116 | **Desktop onboarding wizard** — First-run experience: welcome screen → choose backend (Ollama local / OpenAI cloud / custom) → auto-detect Ollama installation → enter API key if cloud → optional pull a starter model → create first workspace → set theme → done; `client/js/onboarding.js`; skippable for power users; config stored in `userData/setup-complete.json` |

---

## 6. Technical Architecture

### Stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **Auth:** Passport (GitHub, Google), API keys
- **Real-time:** WebSocket (ws)
- **Storage:** JSON files (`data/`), optional SQLite KV, optional PostgreSQL KV for `lib/storage.js`
- **Deployment:** Vercel, Render, self-hosted

### Key Components

```
Client (index.html, admin.html, eval.html)
        ↓
Express Server
  ├── Chat completions (streaming)
  ├── Agent loop / Swarm
  ├── Task planning
  ├── Knowledge API
  ├── Workspaces, teams, quotas
  ├── Webhooks, schedules
  └── Admin API
        ↓
Backend (Ollama | vLLM | OpenAI)
```

### Data Flow

- **Chat:** Client → server → backend (streaming proxy)
- **Agent:** Client → server → backend (tool loop) → tools (storage, action-executor)
- **Swarm:** Client → server → specialists (parallel) → synthesizer → client

---

## 7. Non-Functional Requirements

### Performance

- First-byte latency < 500 ms (excluding backend)
- Streaming: no buffering of full response
- Compression for JSON APIs when `ENABLE_COMPRESSION=1`

### Security

- API keys via header or Bearer
- CORS configurable; CSP in production
- No secrets in logs
- HSTS in production

### Observability

- Structured JSON logs in production
- X-Request-Id on all responses
- Prometheus `/metrics` when `ENABLE_METRICS=1`
- Health probes for k8s/containers

### Availability

- Circuit breaker on backend failures
- Graceful shutdown on SIGTERM
- Retry with backoff for transient errors

---

## 8. Environment Variables Reference

| Variable | Phase | Description |
|----------|-------|-------------|
| `BACKEND` | — | ollama \| vllm \| openai |
| `OPENAI_API_KEY` | — | Required for OpenAI backend |
| `API_KEY` | — | Protects /v1/chat/completions |
| `ENABLE_METRICS` | 40 | Prometheus metrics at /metrics |
| `BACKEND_TIMEOUT_MS` | 41 | Backend fetch timeout (default 60000) |
| `BACKEND_RETRY_MAX` | 41 | Max retries (default 2) |
| `CORS_ORIGINS` | 42 | Comma-separated allowed origins |
| `SWARM_MODEL_RESEARCHER` | 43 | Model for researcher specialist |
| `SWARM_MODEL_EXECUTOR` | 43 | Model for executor specialist |
| `SWARM_MODEL_SYNTHESIZER` | 43 | Model for synthesizer specialist |
| `ENABLE_COMPRESSION` | 44 | gzip for JSON (default 1 in prod) |

See `.env.example` and `docs/RUNBOOK.md` for full list.

---

## 9. API Overview

### Chat & Agent

- `POST /v1/chat/completions` – Streaming chat; agent mode when `agentMode: true`
- `POST /v1/agent/swarm` – Swarm mode (forces `agentMode` + `swarmMode`)
- `POST /v1/swarm` – Direct tool-only swarm
- `POST /v1/tasks/plan` – Task plan generation

### Knowledge

- `POST /api/knowledge/index` – Index document
- `GET /api/knowledge/search` – Keyword/semantic search
- `POST /api/embeddings` – Embed text(s)

### Config & Health

- `GET /config` – Backend, model presets, auth status
- `GET /health` – Backend reachability
- `GET /health/live` – Liveness probe
- `GET /health/ready` – Readiness probe
- `GET /metrics` – Prometheus (when ENABLE_METRICS=1)

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Backend unreachable | Circuit breaker; retry with backoff |
| Secrets in logs | Log sanitization (Phase 36) |
| CORS misconfiguration | `CORS_ORIGINS` for production |
| High latency | Compression; parallel tools; swarm parallelism |
| Single point of failure | Deploy behind load balancer; stateless design |

---

## 11. Appendix

### Related Documents

- [docs/RUNBOOK.md](./RUNBOOK.md) – Operations, troubleshooting
- [docs/AGENT_MODE.md](./AGENT_MODE.md) – Agent & swarm details
- [docs/DEPLOYMENT.md](./DEPLOYMENT.md) – Vercel, Render setup
- [.env.example](../.env.example) – Environment reference

### API Docs

- Swagger UI: `GET /api/docs`
- OpenAPI JSON: `GET /api/docs/openapi.json`
