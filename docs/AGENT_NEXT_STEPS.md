# Siskel Bot — recommended next steps

**Last updated:** April 2026

---

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

---

## Recommended next steps (prioritized)

### P0 — Immediate / high leverage

1. **Extract route handlers from `server.js`** — At 3,954 lines, `server.js` is the largest maintainability bottleneck. Extract route groups into `routes/chat.js`, `routes/admin.js`, `routes/knowledge.js`, `routes/eval.js`, `routes/ocr.js`, and `routes/agents.js`. Keep `server.js` as the composition root that mounts sub-routers. This unblocks parallel development and simplifies code review.

2. **Fix stale OCR test** — `tests/server.test.js:711` still asserts that `POST /api/ocr` returns 501, but the endpoint is now implemented (Tesseract.js). Update the test to validate actual OCR functionality (upload an image, assert extracted text).

3. **Client SPA code splitting** — The main `client/index.html` is ~276KB of inline HTML/JS. Introduce esbuild or a lightweight bundler to split JS into cacheable modules. This improves load times, enables browser caching, and makes the frontend easier to develop and test.

4. **Increase E2E test coverage** — The Playwright suite exists but covers only foundational paths. Add tests for: conversation branching, plugin marketplace install flow, eval harness execution, workspace template cloning, and admin dashboard CRUD operations.

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

- **`server.js` is 3,954 lines** — See P0.1 above. This is the single highest-impact refactor.
- **82 lib files with no barrel exports** — Add `lib/index.js` barrel files per domain (e.g., `lib/agent/index.js`) to simplify imports and establish module boundaries.
- **44 test files, no coverage tracking** — Add `c8` or `istanbul` for code coverage reporting in CI. Set a coverage floor (e.g., 70%) and ratchet up over time.
- **No linting for client JS** — ESLint only covers server-side code. Extend to `client/` with browser-appropriate rules.
- **Docker image size** — Audit and reduce the Alpine image layers. Consider multi-stage build optimization and `.dockerignore` review.

---

See `docs/PRD.md` for the full phase roadmap.
