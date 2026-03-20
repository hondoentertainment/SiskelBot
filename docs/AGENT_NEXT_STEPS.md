# Siskel Bot — recommended next steps for the agent

## Shipped in this iteration

- **Phase 60:** `AGENT_DEFAULT_SYSTEM` — deployment-wide default system text merged into agent and swarm LLM calls (see `.env.example`, `lib/agent-defaults.js`).

## Near-term (high leverage)

1. **Per-workspace system overrides** — Store optional `defaultSystemPrompt` in workspace metadata and merge after env default (team-specific tone/rules).
2. **Structured “memory” snippets** — User-approved bullets in `context.json` or a small `agent-memory.json` per workspace; inject as a system section when `agentMode` is on.
3. **Eval expansion** — More `target: "trace"` cases in CI; optional recorded traces from staging runs fed into golden checks.
4. **Client hint** — When `GET /config` reports `agentDefaultSystemSet`, show a subtle “Server defaults active” in Settings (no prompt text leakage).

## Medium-term

5. **Postgres / durable trajectory** — Replace in-memory trajectory store for multi-instance deployments.
6. **Plugin marketplace (PRD 49)** — Curated action packs with signed manifests.
7. **Auto-instrumentation (PRD 47)** — HTTP + fetch spans when OTEL is on.

## Longer-term

8. **Multi-region & audit archival** (PRD 45/48) — For enterprise operations.

See `docs/PRD.md` for the full phase roadmap.
