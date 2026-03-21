# Siskel Bot — recommended next steps for the agent

## Shipped in this iteration

- **Phase 60:** `AGENT_DEFAULT_SYSTEM` — deployment-wide default system text merged into agent and swarm LLM calls (see `.env.example`, `lib/agent-defaults.js`).
- **Phases 61–62:** Per-workspace `defaultSystemPrompt` + `memorySnippets[]` — stored at `data/users/{storageUserId}/workspaces/{id}/agent-settings.json`, merged after the deployment default in **agent mode** and **swarm** (specialists + synthesizer). API: `GET` / `PUT /api/workspaces/:id/agent-settings` (and `/api/v1/...`). See `lib/workspace-agent-settings.js`, `.env.example` (`WORKSPACE_AGENT_*` caps).
- **Phase 63:** Settings panel shows a notice when `GET /config` → `agentDefaultSystemSet` (no prompt text exposed).
- **Phase 64:** Settings → workspace system prompt + approved memory (lines) with Reload/Save calling the agent-settings API.
- **Phase 65:** `data/eval-sets/example.json` includes offline `target: "trace"` cases; tests assert they pass.

## Near-term (high leverage)

1. ~~**Per-workspace system overrides**~~ — Done (Phase 61).
2. ~~**Structured “memory” snippets**~~ — Done (Phase 62; approved bullets as `memorySnippets`).
3. ~~**Eval expansion (starter)**~~ — Done (Phase 65 in `example.json`); add more sets / staging-recorded traces as needed.
4. ~~**Client hint**~~ — Done (Phase 63).
5. **Staging trace replay** — Optional recorded trajectories from staging fed into golden checks.

## Medium-term

6. **Postgres coverage (Phase 68)** — `lib/storage.js` supports `STORAGE_BACKEND=postgres`; migrate teams, schedules, webhooks, `agent-settings.json`, etc. off raw files. Replace in-memory trajectory store for multi-instance deployments.
7. **Plugin marketplace (PRD 49)** — Curated action packs with signed manifests.
8. **Deeper OTEL (Phase 69)** — DB spans, sampling, custom attributes beyond HTTP + fetch (Phase 67 shipped).

## Longer-term

9. **Multi-region & audit archival** (PRD 45/48) — For enterprise operations.

See `docs/PRD.md` for the full phase roadmap.
