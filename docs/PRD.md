# Experiment Agent – Product Requirements Document

**Version:** 1.0  
**Last updated:** March 2025

---

## 1. Executive Summary

Experiment Agent is a production-grade, realtime streaming assistant proxy that connects clients to LLM backends (Ollama, vLLM, OpenAI). It provides chat completions, agentic autonomy with tools, multi-agent swarms, task planning, knowledge search, scheduled recipes, and team collaboration—all behind a single OpenAI-compatible API.

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

### Future Phases (Planned)

| Phase | Name | Priority |
|-------|------|----------|
| 45 | Audit log retention & archival | Medium |
| 46 | Storage abstraction (Postgres) | High |
| 47 | Distributed tracing (OpenTelemetry) | Medium |
| 48 | Multi-region deployment | Low |
| 49 | Plugin marketplace | Low |

---

## 6. Technical Architecture

### Stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **Auth:** Passport (GitHub, Google), API keys
- **Real-time:** WebSocket (ws)
- **Storage:** JSON files (data/)
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
