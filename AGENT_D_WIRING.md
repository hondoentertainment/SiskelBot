# Agent D Wiring

The 15 route modules below need to be mounted from `routes/index.js`. Do **not**
wire them from within this worktree — the integrator should apply the edits below
to `routes/index.js` (imports and `mountFunctions` array). No changes are needed
in `server.js` or `package.json`.

## Imports (add to `routes/index.js`)

```js
// Phase 65 — Enterprise Governance
import mountModelApprovalRoutes from "./model-approval.js";
import mountUsagePoliciesRoutes from "./usage-policies.js";
import mountBudgetAllocationRoutes from "./budget-allocation.js";
import mountAuditReportsRoutes from "./audit-reports.js";
import mountAiRiskScoringRoutes from "./ai-risk-scoring.js";

// Phase 67 — Content Moderation
import mountHashDetectionRoutes from "./hash-detection.js";
import mountCopyrightSimilarityRoutes from "./copyright-similarity.js";
import mountFactualityCrossrefRoutes from "./factuality-crossref.js";
import mountBrandSafetyRoutes from "./brand-safety.js";
import mountHitlModerationRoutes from "./hitl-moderation.js";

// Phase 68 — Knowledge Augmentation
import mountWebIngestionRoutes from "./web-ingestion.js";
import mountLargeRetrievalRoutes from "./large-retrieval.js";
import mountFactVerificationRoutes from "./fact-verification.js";
import mountSourceCredibilityRoutes from "./source-credibility.js";
import mountFreshnessSlaRoutes from "./freshness-sla.js";
```

## mountFunctions entries (append to the `mountFunctions` array)

```js
  // Phase 65 — Enterprise Governance
  mountModelApprovalRoutes,
  mountUsagePoliciesRoutes,
  mountBudgetAllocationRoutes,
  mountAuditReportsRoutes,
  mountAiRiskScoringRoutes,

  // Phase 67 — Content Moderation
  mountHashDetectionRoutes,
  mountCopyrightSimilarityRoutes,
  mountFactualityCrossrefRoutes,
  mountBrandSafetyRoutes,
  mountHitlModerationRoutes,

  // Phase 68 — Knowledge Augmentation
  mountWebIngestionRoutes,
  mountLargeRetrievalRoutes,
  mountFactVerificationRoutes,
  mountSourceCredibilityRoutes,
  mountFreshnessSlaRoutes,
```

## Module-to-route map

| # | Module | Lib path | Route path | Test path | Base endpoint |
|---|--------|----------|------------|-----------|----------------|
| 65.1 | Model approval workflows | `lib/model-approval.js` | `routes/model-approval.js` | `tests/model-approval.test.js` | `/api/v1/model-approvals` |
| 65.2 | Usage policies | `lib/usage-policies.js` | `routes/usage-policies.js` | `tests/usage-policies.test.js` | `/api/v1/usage-policies` |
| 65.3 | Budget allocation | `lib/budget-allocation.js` | `routes/budget-allocation.js` | `tests/budget-allocation.test.js` | `/api/v1/budget/cost-centers` |
| 65.4 | Audit report generation | `lib/audit-reports.js` | `routes/audit-reports.js` | `tests/audit-reports.test.js` | `/api/v1/audit-reports` |
| 65.5 | AI risk scoring (NIST RMF) | `lib/ai-risk-scoring.js` | `routes/ai-risk-scoring.js` | `tests/ai-risk-scoring.test.js` | `/api/v1/ai-risk` |
| 67.1 | Hash-based detection (stub) | `lib/hash-detection.js` | `routes/hash-detection.js` | `tests/hash-detection.test.js` | `/api/v1/hash-detection` |
| 67.2 | Copyright similarity | `lib/copyright-similarity.js` | `routes/copyright-similarity.js` | `tests/copyright-similarity.test.js` | `/api/v1/copyright/corpora` |
| 67.3 | Factuality cross-reference | `lib/factuality-crossref.js` | `routes/factuality-crossref.js` | `tests/factuality-crossref.test.js` | `/api/v1/factuality` |
| 67.4 | Brand safety rules | `lib/brand-safety.js` | `routes/brand-safety.js` | `tests/brand-safety.test.js` | `/api/v1/brand-safety` |
| 67.5 | HITL moderation queue | `lib/hitl-moderation.js` | `routes/hitl-moderation.js` | `tests/hitl-moderation.test.js` | `/api/v1/hitl-moderation` |
| 68.1 | Real-time web ingestion | `lib/web-ingestion.js` | `routes/web-ingestion.js` | `tests/web-ingestion.test.js` | `/api/v1/web-ingestion` |
| 68.2 | Large-scale retrieval | `lib/large-retrieval.js` | `routes/large-retrieval.js` | `tests/large-retrieval.test.js` | `/api/v1/large-retrieval` |
| 68.3 | Fact verification (agent output) | `lib/fact-verification.js` | `routes/fact-verification.js` | `tests/fact-verification.test.js` | `/api/v1/fact-verification` |
| 68.4 | Source credibility | `lib/source-credibility.js` | `routes/source-credibility.js` | `tests/source-credibility.test.js` | `/api/v1/source-credibility` |
| 68.5 | Freshness SLAs | `lib/freshness-sla.js` | `routes/freshness-sla.js` | `tests/freshness-sla.test.js` | `/api/v1/freshness-sla` |

## Notes

- All routes use the existing `apiRoute`/`apiError`/`logRequest`/`adminAuth` deps pattern from `routes/canary.js`.
- All storage goes through `lib/json-path-store.js` with keys under `data/<module-name>/…`.
- Phase 67.1 is an interface stub — `lib/hash-detection.js` ships no hash lists. Operators must register their own provider (`registerProvider(id, { check })`) at server bootstrap.
- Phase 67.2 indexes only user-provided corpora; no content is preloaded.
- Phase 67.3 and 68.3 share the same underlying cross-reference mechanic (`factuality-crossref.js`). 68.3 is specialized for agent-output tracking and emits per-run/per-message verdicts.
- Phase 68.2 uses `lib/embeddings.js` when `OPENAI_API_KEY` is set; otherwise a deterministic fallback keeps tests/dev offline-safe.
- Phase 68.1 defers actual fetching to `lib/knowledge-url-fetch.js`, which enforces `KNOWLEDGE_URL_ALLOWLIST`. Tests inject a fake fetcher.
