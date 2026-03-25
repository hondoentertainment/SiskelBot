# Siskel Bot — recommended next steps

**Last updated:** March 2026

---

## Previously shipped

- **Phases 93–96:** Eval harness — live `chat` eval cases, SSE parsing for `agent_activity`, criteria matching, skip support, Activity column in `/eval` UI.
- **Phase 60:** `AGENT_DEFAULT_SYSTEM` — deployment-wide default system text for agent/swarm LLM calls.
- **Phases 61–64:** Per-workspace `defaultSystemPrompt` + `memorySnippets[]`, settings panel with Reload/Save, client hint when deployment default is set.
- **Phase 65:** Offline `target: “trace”` eval cases in `data/eval-sets/example.json`.

---

## Recommended next steps (prioritized)

### P0 — Immediate / high leverage

1. **Implement OCR endpoint** — `POST /api/ocr` currently returns 501. Integrate Tesseract.js (local) or a cloud OCR provider to unlock document-image ingestion in the knowledge pipeline. This is the only shipped route that returns “Not Implemented” and is a gap for users uploading scanned documents.

2. **E2E test automation** — The test suite (29 files) covers unit and integration well, but E2E flows are manual. Add Playwright tests for critical paths: login → chat → agent tool call → response, admin dashboard CRUD, eval harness run. This protects against UI regressions as the client SPA grows.

3. **Staging trace replay (Phase 65 follow-up)** — Record agent/swarm trajectories from staging and feed them into the eval harness as golden traces. This closes the loop between production behavior and regression testing without needing live LLM calls in CI.

4. **API key scopes enforcement** — The env var syntax supports `key:userId:scopes` but scope checking is not enforced at runtime. Wire up scope validation (`read`, `write`, `admin`, `embed`) in the auth middleware to enable least-privilege API keys for integrators.

### P1 — Near-term (next 1–2 iterations)

5. **Postgres coverage expansion (Phase 68)** — Several storage paths still fall back to JSON files (e.g., eval sets, workspace agent settings, webhook subscriptions). Migrate remaining file-only paths to `json-path-store` for production durability and multi-instance deployments.

6. **Offline message queue** — The PWA disables the send button when offline. Implement a client-side IndexedDB queue that stores messages offline and replays them on reconnect, improving the mobile experience.

7. **Deeper OpenTelemetry instrumentation (Phase 69)** — Add spans for agent tool execution, swarm specialist dispatch, knowledge search, and recipe step execution. Enable tail sampling via an OpenTelemetry Collector sidecar config (document in `docs/RUNBOOK.md`).

8. **Custom JS plugins (Phase 17.1)** — Currently only config-based plugins are supported. Add a sandboxed JS plugin runtime (e.g., isolated-vm or Node.js worker threads) so integrators can write custom action handlers beyond webhook and builtin types.

### P2 — Medium-term

9. **Plugin marketplace (PRD Phase 49)** — Curated action packs with signed manifests, a discovery UI in the admin dashboard, and one-click install into workspaces.

10. **Conversation branching & forking** — Allow users to branch a conversation at any message to explore alternative agent paths. Store branches as linked conversation trees. This is high value for AI engineers comparing model behaviors.

11. **Multi-model A/B routing** — Extend the backend config to support weighted routing across multiple models (e.g., 80% gpt-4o / 20% local Ollama). Log which model served each request for eval comparison. Builds on the existing fallback backend mechanism.

12. **Workspace templates** — Allow admins to create workspace templates (pre-configured system prompts, memory snippets, tool allowlists, quota settings) that new workspaces can clone from. Reduces onboarding friction for teams.

### P3 — Longer-term / enterprise

13. **Multi-region & HA (PRD Phases 45–48)** — Active-active deployment with cross-region storage replication, leader election for scheduled recipes, and geo-routed health probes. See `docs/MULTI_REGION_HA.md` for the existing design.

14. **Audit archival to S3** — Currently supported but needs automated lifecycle policies, Athena/BigQuery integration for querying archived audit logs, and a retention configuration UI in the admin dashboard.

15. **SSO / SAML integration** — Extend OAuth beyond GitHub/Google to support enterprise SAML/OIDC providers for organizations that require centralized identity management.

---

## Technical debt & quality

- **`server.js` is 3,300+ lines** — Extract route handlers into dedicated route files (e.g., `routes/chat.js`, `routes/admin.js`, `routes/knowledge.js`) to improve maintainability and code review ergonomics.
- **Client SPA is ~275KB inline HTML** — Consider splitting into modules with a lightweight bundler (esbuild) for better cacheability and developer experience.
- **No TypeScript** — The codebase is pure JS with ES modules. Adding JSDoc type annotations or migrating critical modules (agent-loop, swarm, storage) to TypeScript would catch bugs earlier.

---

See `docs/PRD.md` for the full phase roadmap (Phases 79–96 implemented).
