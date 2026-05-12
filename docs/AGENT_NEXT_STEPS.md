# Siskel Bot — recommended next steps

**Last updated:** May 2026

---

## Recent additions (agent quality & desktop)

- **CI offline eval:** `npm run eval:ci` + [`data/eval-sets/ci-offline.json`](https://github.com/hondoentertainment/SiskelBot/blob/main/data/eval-sets/ci-offline.json) in GitHub Actions; optional `EVAL_LIVE=1 npm run eval:live`. See [docs/AGENT_SLI](/docs/AGENT_SLI), [docs/RUNBOOK](/docs/RUNBOOK) (CI eval row).
- **HITL `execute_step`:** `AGENT_EXECUTE_STEP_HITL` / `requireExecuteStepApproval`; `POST /v1/agent/resume-execute-step`; SSE `agent_pending_execution`. See [docs/AGENT_MODE](/docs/AGENT_MODE).
- **`AGENT_VERIFY_PASS`:** Optional post-success verification paragraph in the agent loop.
- **Marketplace signing helper:** `computeUnsignedManifestDigestHex`, [`scripts/marketplace-manifest-digest.mjs`](https://github.com/hondoentertainment/SiskelBot/blob/main/scripts/marketplace-manifest-digest.mjs).
- **SDK:** [`examples/sdk-starter.ts`](https://github.com/hondoentertainment/SiskelBot/blob/main/examples/sdk-starter.ts) — `chatCompletions` / `agentChatExample`.

## Previously shipped

All items from the original P0–P3 roadmap have been implemented:

- **P0.1:** OCR endpoint with Tesseract.js (ddba245)
- **P0.2:** E2E Playwright test suite (145d69f)
- **P0.3:** Staging trace replay system (0f617a3)
- **P0.4:** API key scopes enforcement (6cc5f25)
- **P1.5:** Postgres coverage expansion (2f8308d)
- **P1.6:** Offline message queue for PWA (6fade9b)
- **P1.7:** Deeper OpenTelemetry instrumentation (5157779)
- **P1.8:** Custom JS plugin sandbox runtime (f4fa189)
- **P2.9:** Plugin marketplace with discovery UI (7b3f7d0)
- **P2.10:** Conversation branching & forking (088bf30)
- **P2.11:** Multi-model A/B routing (1398af1)
- **P2.12:** Workspace templates system (11d0403)
- **P3.13:** Multi-region HA with leader election (e76bed9)
- **P3.14:** S3 audit archival with query/export (9370a5f)
- **P3.15:** SSO/SAML/OIDC integration (e91fa6d)
- **Phases 93–96:** Eval harness — live chat eval cases, SSE parsing, criteria matching, offline eval sets.
- **Phase 60–65:** Default agent system, workspace agent settings, client hints, golden-trace evals in `example.json`.

---

## Recommended next steps (prioritized)

### P0 — Immediate / high leverage

1. **World-class agent program** — Follow [docs/AGENT_WORLD_CLASS_ROADMAP](/docs/AGENT_WORLD_CLASS_ROADMAP): finish **Phase 6 (browser)** (domain allowlists, HITL, golden evals), **Phase 8** (planner on session + re-plan after tool failure — partial: upfront plan persists to session and agent checkpoints now carry `upfrontPlanDag` when `AGENT_UPFRONT_PLAN=1`), and expand **golden traces** for each new tool class.

2. **CI reliability** — `npm run test:ci` uses `npx c8` for portable Windows/Linux behavior; ensure `npm ci` completes (avoid OneDrive-locked `node_modules`). Optionally require `lint`, `test`, and Trivy on `main` via GitHub branch protection.

3. **Continue modular `routes/*`** — `server.js` is the thin bootstrap; composition lives in `lib/server-configured-app.js` + `routes/index.js`. Prefer new `routes/<domain>.js` modules and register them in `mountFunctions`.

4. **E2E depth** — Suite includes branching, marketplace, admin CRUD, workspace templates, eval, pricing page, etc.; keep adding critical product paths as APIs evolve.

### P1 — Near-term (next 1–2 iterations)

5. **Type checking** — `tsconfig.json` uses `checkJs` on a **narrow** include list. To type-check `lib/swarm.js`, add **`@types/node`** and evolve `types/siskelbot.d.ts` until `tsc` is clean, then widen `include`.

6. **Rate limiting** — Chat, per-key chat, embeddings, and knowledge indexing limiters include a **workspace-derived suffix** when `workspace` / `agentOptions.workspace` / `x-workspace-id` is present; `lib/workspace-rate-limit.js` resolves workspace from param, body, query, `req.workspace`, and header. **Sliding-window** workspace limits remain env-driven (`WORKSPACE_RATE_LIMIT_*`).

7. **Knowledge** — `lib/knowledge-parsers.js` already supports **DOCX, XLSX, HTML**, CSV, JSON, Markdown; per-workspace chunking is in `lib/knowledge-chunking-config.js`. Next: richer metadata extraction and format-specific tuning.

8. **WebSocket reconnection hardening** — Exponential backoff with jitter, UI connection state, replay queued events after reconnect.

### P2 — Medium-term

9. **API versioning enforcement** — Version-aware response serialization so v1 clients stay stable as schemas evolve.

10. **Observability dashboard** — Built-in `/admin/observability` for key OTel-derived metrics without external Grafana.

11. **Agent memory persistence** — Long-term user/project facts across conversations with consent + management UI (reasoning-memory / agent memory tracks exist — productize).

12. **Workspace migration tooling** — Full export/import of workspace state for portability.

### P3 — Longer-term / enterprise

13. **RBAC granularity** — Custom roles and fine-grained permissions.

14. **Federated deployment** — Cross-instance workspace discovery.

15. **Compliance & data residency** — Region pinning, PII tooling, audit reports.

---

## Technical debt & quality

- **Barrel exports** — Optional domain `lib/agent/index.js`-style barrels for clearer imports.
- **Coverage** — `c8` + `scripts/check-critical-coverage.mjs` in CI; ratchet thresholds as files stabilize.
- **Client ESLint** — Extend lint to `client/src` with browser globals.
- **Docker image size** — Multi-stage builds and `.dockerignore` audit.
- **Legacy client shell** — `client/index.html` may still be large; `scripts/build-client.mjs` + `client/src` provide esbuild **splitting** for modern SPA paths (`client/app.html` / dist manifest).

---

See `docs/PRD.md` for the full phase roadmap (**Phases 79–97** include `AGENT_TOOLS_ALLOWLIST`, `SWARM_SPECIALISTS_ALLOWLIST`, `agentOptions.maxIterations`, eval agent/swarm harness, and `GET /api/eval/staging-traces` for `staging_trace` cases).
