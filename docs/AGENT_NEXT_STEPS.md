# Siskel Bot — recommended next steps

**Last updated:** April 2026 (phases 51–70 landed)

---

## Recent additions (agent quality & desktop)

- **CI offline eval:** `npm run eval:ci` + [`data/eval-sets/ci-offline.json`](data/eval-sets/ci-offline.json) in GitHub Actions; optional `EVAL_LIVE=1 npm run eval:live`. See [`docs/AGENT_SLI.md`](AGENT_SLI.md), [`docs/RUNBOOK.md`](RUNBOOK.md) (CI eval row).
- **HITL `execute_step`:** `AGENT_EXECUTE_STEP_HITL` / `requireExecuteStepApproval`; `POST /v1/agent/resume-execute-step`; SSE `agent_pending_execution`. See [`docs/AGENT_MODE.md`](AGENT_MODE.md).
- **`AGENT_VERIFY_PASS`:** Optional post-success verification paragraph in the agent loop.
- **Marketplace signing helper:** `computeUnsignedManifestDigestHex`, [`scripts/marketplace-manifest-digest.mjs`](scripts/marketplace-manifest-digest.mjs).
- **SDK:** [`examples/sdk-starter.ts`](examples/sdk-starter.ts) — `chatCompletions` / `agentChatExample`.

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

1. **Connect phase 52 reasoning modules to the agent loop** — `lib/tree-of-thought.js`, `lib/self-consistency.js`, `lib/graph-of-thought.js`, `lib/verification-loop.js`, and the new `lib/neuro-symbolic.js` are exposed as HTTP endpoints but not referenced by `lib/agent-loop.js`. Wire them as selectable reasoning strategies on the agent session (`reasoning: "tot" | "self-consistency" | "got" | "neuro-symbolic"`).

2. **Integrate phase 51 safety into the chat pipeline** — `routes/chat.js` still streams output without running it through `lib/jailbreak-detector.js`, `lib/output-classifiers.js`, `lib/constitutional-ai.js`, or the new `lib/red-team.js`. Add a streaming safety filter that can block/deflect/redact mid-stream.

3. **Run safety-evals in CI** — `lib/safety-evals.js` provides `runAllSets` and `compareToBaseline`. Add a `npm run eval:safety` script and a GitHub Action that compares against the stored baseline and fails CI on regression.

4. **E2E smoke for new phase routes** — The 84 new phase 51-70 route modules are mounted but uncovered by `scripts/smoke-test.js`. Add a smoke check that hits at least one endpoint per phase to catch accidental regressions from route renames.

### P1 — Near-term (next 1–2 iterations)

5. **Add TypeScript to critical modules** — Migrate `lib/agent-loop.js`, `lib/swarm.js`, `lib/storage.js`, and `lib/auth.js` to TypeScript (or add comprehensive JSDoc type annotations with `// @ts-check`). These are the highest-churn, highest-risk modules. Start with JSDoc + tsconfig `checkJs` for zero-build-step adoption.

6. **Rate limiting improvements** — Add per-workspace rate limits (not just per-user) and sliding window support. Expose rate limit headers (`X-RateLimit-Remaining`, `X-RateLimit-Reset`) consistently across all API endpoints.

7. **Knowledge pipeline V2 enhancements** — Add support for additional document formats (DOCX, XLSX, HTML) in the RAG pipeline. Implement chunking strategy configuration per workspace (chunk size, overlap, metadata extraction).

8. **WebSocket reconnection hardening** — Implement exponential backoff with jitter for WebSocket reconnections. Add connection state indicators in the client UI and queue missed events for replay on reconnect.

### P2 — Medium-term

9. **API versioning enforcement** — The OpenAPI spec and versioning infrastructure exist but response formats aren't locked to versions. Add version-aware response serialization so v1 clients aren't broken by v2 schema changes.

10. **Observability dashboard** — Create a built-in `/admin/observability` page that surfaces key OpenTelemetry metrics (p50/p95 latency, error rates, active agents, token usage) without requiring an external Grafana/Prometheus stack.

11. **Agent memory persistence** — Extend conversation memory beyond the session. Allow agents to store and retrieve long-term facts about users/projects across conversations, with explicit user consent and a management UI.

12. **Workspace migration tooling** — Add export/import for complete workspace state (conversations, settings, templates, knowledge base) to enable workspace portability between deployments.

### P3 — Longer-term / enterprise

13. **RBAC granularity** — Extend team roles beyond basic admin/member. Add custom role definitions with fine-grained permissions (e.g., can manage knowledge base but not billing, can view but not execute agents).

14. **Federated deployment** — Support connecting multiple SiskelBot instances into a federation where users can discover and interact with workspaces across instances. Builds on the multi-region HA foundation.

15. **Compliance & data residency** — Add data residency controls (per-workspace region pinning), automated PII detection/redaction in conversations, and compliance audit report generation for SOC 2 / GDPR.

---

## Technical debt & quality

- **`server.js` is now 1,073 lines** — Down from 3,954. Further decomposition is low priority.
- **Pre-existing ESLint errors in `client/`, `edge/`, `mobile/`, `mobile-sdk/`, and two reasoning lib modules** — 70 errors total (all pre-existing, none introduced by phase 51–70 work). These need a separate cleanup pass.
- **Test coverage tracking** — `c8` is wired (`npm run test:coverage`) with thresholds in `.c8rc.json`; phase 51–70 modules added ~1,040 tests.
- **No linting for client JS** — ESLint only covers server-side code. Extend to `client/` with browser-appropriate rules.
- **Docker image size** — Audit and reduce the Alpine image layers.

---

See `docs/PRD.md` for the full phase roadmap (**Phases 79–97** include `AGENT_TOOLS_ALLOWLIST`, `SWARM_SPECIALISTS_ALLOWLIST`, `agentOptions.maxIterations`, eval agent/swarm harness, and `GET /api/eval/staging-traces` for `staging_trace` cases).
