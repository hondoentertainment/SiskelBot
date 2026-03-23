# Siskel Bot — recommended next steps for the agent

## Shipped in this iteration

- **Phases 93–96 (eval harness):** Live `chat` eval cases merge `chatRequestDefaults` and per-case `chatRequest` / top-level overrides into `POST /v1/chat/completions` (agent/swarm fields). SSE responses are parsed for assistant text and `agent_activity`; criteria include `expectedAgentActivityToolNames`, `expectedAgentActivityToolSequence`, `expectedMinAgentActivityToolCalls`, `expectedSwarmStepNames`, `expectedMinSwarmSteps`. Per-case `skip` / `skipReason`; `runEvalSet` returns `skipped` and non-skipped `passed`; results may include `agentActivityHint`. Docs: `docs/RUNBOOK.md` Phase 32, `docs/PRD.md` phases 93–96. Templates: `data/eval-sets/example.json`, `data/eval-sets/agent-outcome-examples.json`. UI: `/eval` skipped styling and Activity column.
- **Phase 60:** `AGENT_DEFAULT_SYSTEM` — deployment-wide default system text merged into agent and swarm LLM calls (see `.env.example`, `lib/agent-defaults.js`).
- **Phases 61–62:** Per-workspace `defaultSystemPrompt` + `memorySnippets[]` — stored at `data/users/{storageUserId}/workspaces/{id}/agent-settings.json`, merged after the deployment default in **agent mode** and **swarm** (specialists + synthesizer). API: `GET` / `PUT /api/workspaces/:id/agent-settings` (and `/api/v1/...`). See `lib/workspace-agent-settings.js`, `.env.example` (`WORKSPACE_AGENT_*` caps).
- **Phase 63:** Settings panel shows a notice when `GET /config` → `agentDefaultSystemSet` (no prompt text exposed).
- **Phase 64:** Settings → workspace system prompt + approved memory (lines) with Reload/Save calling the agent-settings API.
- **Phase 65:** `data/eval-sets/example.json` includes offline `target: "trace"` cases; tests assert they pass.

## Near-term (high leverage)

1. ~~**Per-workspace system overrides**~~ — Done (Phase 61).
2. ~~**Structured “memory” snippets**~~ — Done (Phase 62; approved bullets as `memorySnippets`).
3. ~~**Eval expansion (starter)**~~ — Done (Phase 65 in `example.json`); Phases 93–96 add live-agent templates (`skip: true` by default). Add more sets / staging-recorded traces as needed.
4. ~~**Client hint**~~ — Done (Phase 63).
5. **Staging trace replay** — Optional recorded trajectories from staging fed into golden checks.

## Medium-term

6. **Postgres coverage (Phase 68)** — Durable tenant modules on `json-path-store` (see PRD). Expand coverage if any paths still file-only.
7. **Plugin marketplace (PRD 49)** — Curated action packs with signed manifests.
8. **Deeper OTEL (Phase 69)** — Further spans/sampling beyond Phase 67/69 baseline.

## Longer-term

9. **Multi-region & audit archival** (PRD 45/48) — For enterprise operations.

See `docs/PRD.md` for the full phase roadmap (**Phases 79–96 implemented** — includes **Phase 89** `AGENT_TOOLS_ALLOWLIST`, **Phase 91** `SWARM_SPECIALISTS_ALLOWLIST`, **Phase 92** `agentOptions.maxIterations`, **Phases 93–96** eval agent/swarm harness).
