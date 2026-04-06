# Agent service level indicators (SLIs)

Use these with existing Prometheus metrics (`ENABLE_METRICS=1`, `/metrics`) and structured logs to monitor agent quality in production.

| SLI | Source | Notes |
|-----|--------|--------|
| Agent wall time | `agent_phase_ms` buckets / logs with `X-Agent-Run-Id` | Track p95 for `single` mode phases `llm`, `tools`, `reflect`, `verify` |
| Truncation rate | Response headers `X-Agent-Truncated`, `stopReason` in `agent_activity` | Values: `wall_clock`, `tool_budget`, `max_iterations` |
| Tool failure rate | `agent_activity` / trajectory `tool_result` vs `tool_error` | Per workspace or deployment |
| Citation gaps | Header `X-Agent-Citations-Missing` when `AGENT_REQUIRE_CITATIONS=1` | Count fraction of agent responses |
| Stagnation stops | `stopReason: stagnation` in activity payload | Spikes may indicate model or prompt regressions |
| HITL pending | Header `X-Agent-Pending-Execute-Step`, SSE `agent_pending_execution` | Tracks how often `execute_step` awaits human approval |

**OpenTelemetry:** With `OTEL_ENABLED=1`, spans include `agent.run_id`, `agent.iteration`, and `tool.name` on tool invocations. Add trace attributes or exemplars in Grafana/Lightstep as needed.

**Postgres / multi-instance:** Tenant modules that must not stay file-only when running more than one Node process are documented in the PRD Phase 68 list; prefer `STORAGE_BACKEND=postgres` with `DATABASE_URL` for schedules, teams, webhooks, quotas, agent-settings, agent trajectories (when durable), and marketplace registry paths under `json-path-store`.
