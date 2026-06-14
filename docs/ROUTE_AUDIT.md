# Route Audit

Classification of every route module in `routes/index.js`.

**Tiers:**
- `CORE` — Fundamental to the product. Keep. Must be live and tested.
- `SUPPORTING` — Enables core features or serves a clear user need. Keep.
- `DEFER` — Legitimate SaaS feature but not needed before PMF. Disable until a user asks.
- `DELETE` — No plausible path to ICP revenue. Remove from `routes/index.js`. Return 404 (not even 501).

**Action rule:** Any route in DEFER returns `501 Not Implemented`. Any route
in DELETE is removed from `routes/index.js` and the file is deleted or archived.

**Target after cleanup:** 40–60 live route modules (CORE + SUPPORTING only).

---

## CORE — Keep, must be live

| Module | Path(s) | Reason |
|---|---|---|
| `auth.js` | `/config`, `/auth/*` | Login, OAuth, session — gating everything |
| `chat.js` | `/v1/chat/completions`, `/v1/agent/swarm`, `/v1/swarm` | The product |
| `health.js` | `/health/*`, `/metrics` | Ops necessity |
| `knowledge.js` | `/api/context*`, `/api/embeddings*`, `/api/knowledge*` | Core differentiation (RAG + knowledge graph) |
| `workspaces.js` | `/api/workspaces*`, templates, agent settings | Multi-tenant foundation |
| `conversations.js` | `/api/conversations*` | Users need conversation history |
| `billing.js` | `/api/v1/billing/*` | Revenue. Already wired to Stripe. |
| `memory.js` | (agent memory) | Agent loop depends on this |
| `agent-run-stream.js` | (realtime agent run stream) | Required for swarm UX |
| `agent-hitl.js` | (human-in-the-loop) | Required for safe agent execution |
| `agent-artifacts.js` | (agent output artifacts) | Required for agent results display |
| `context.js` | (v2 documents/context) | v2 API compatibility |
| `mcp.js` | `/mcp`, `/mcp/sse` | MCP server — active community adoption |

---

## SUPPORTING — Keep, clear user value

| Module | Path(s) | Reason |
|---|---|---|
| `tasks.js` | `/v1/tasks/plan` | Task planning endpoint |
| `integrations.js` | `/api/github/*`, `/api/vercel/*` | GitHub and Vercel are core dev integrations |
| `slack-discord.js` | `/api/integrations/slack/*`, `/api/integrations/discord/*` | Bot integrations with clear enterprise use |
| `recipes.js` | `/api/recipes*`, `/api/schedules*` | Automation — differentiator feature |
| `execute.js` | `/api/execute-step`, `/api/automations/validate` | Recipe execution |
| `webhooks.js` | `/api/webhooks*`, notifications, presence | Outbound events + real-time sync |
| `teams.js` | `/api/teams/*` | Multi-tenant teams |
| `rbac.js` | (RBAC) | Permission system — needed for teams |
| `admin.js` | `/api/admin/*`, routing, regions | Admin dashboard + quota management |
| `admin-agent-stats.js` | `/api/admin/agent-stats` | Ops visibility |
| `admin-quotas.js` | (quota management) | Needed once billing is live |
| `pricing-engine.js` | `/api/v1/pricing/*` | Advanced admin pricing rules + cost compute (requires admin auth) |
| `admin-feature-flags.js` | (feature flags) | Safe rollout mechanism |
| `admin-prompt-patches.js` | (prompt patches) | Ops — override system prompts |
| `eval.js` | `/api/eval*`, `/api/traces*`, `/api/agent/trajectory*` | Model quality feedback loop |
| `collaboration.js` | (real-time collaboration) | Multi-user workspaces |
| `presence.js` | (workspace presence) | Part of collaboration |
| `usage.js` | `/api/usage*`, `/api/analytics*` | Usage dashboard for users and admins |
| `analytics.js` | (analytics) | Paired with usage |
| `backup.js` | `/api/backup*` | Data safety — critical for self-hosted |
| `multimodal.js` | `/api/vision/describe`, `/api/documents/extract`, `/api/ocr` | Document upload is core to knowledge base flow |
| `feedback.js` | (user feedback) | Thumbs up/down on responses |
| `agent-feedback.js` | (agent feedback) | Model improvement signal |
| `security.js` | (security basics) | Input sanitization, rate limiting support |
| `model-quality.js` | (model quality routing) | Smart routing between backends |
| `replay.js` | (session replay) | Agent debug / support tool |
| `trajectory-branch.js` | (trajectory branching) | Agent session branching |
| `agent-resume.js` | (agent resume) | Pause/resume agent runs |
| `signals.js` | (signals) | Real-time UI signals |
| `observability-snapshot.js` | (observability) | Snapshot for debugging |
| `docs.js` | `/api/docs*`, `/docs` | OpenAPI docs |
| `search.js` (if exists separately) | `/api/search*` | Unified search |
| `secrets.js` | (secrets vault) | Required for agent tool execution |
| `playbooks.js` | (playbooks) | Agent playbook execution |
| `wiki.js` | (wiki) | Internal knowledge management |
| `codebase-search.js` | (codebase search) | Code vertical — high-value for dev teams |
| `github-workflow.js` | (GitHub workflow) | Code vertical |
| `pr-review-agent.js` | (PR review) | Code vertical — strong ICP fit |
| `repo-rag.js` | (repo RAG) | Code vertical |
| `session-insights.js` | (session insights) | Useful agent analytics |
| `reasoning-memory.js` | (reasoning memory) | Agent reasoning chain persistence |

---

## DEFER — Disable until a paying user requests it

These are legitimate SaaS features that add real complexity and maintenance
burden. Disable (return `501`) until there is at least one user explicitly
asking for them.

| Module | Reason to defer |
|---|---|
| `voice.js`, `voice-realtime.js`, `voice-cloning.js`, `voice-commands.js`, `diarization.js` | Voice is a full product vertical. No ICP signal yet. |
| `federation.js` | Multi-region federation. Zero users need this before 10K MAU. |
| `multi-region.js` | Same. |
| `geo-routing.js` | Same. |
| `ldap.js` | Enterprise-only. Defer until enterprise customer asks. |
| `hsm.js` | Hardware Security Module. Same. |
| `scim.js` | Enterprise SSO provisioning. Same. |
| `jit-provisioning.js` | Same. |
| `group-sync.js` | Same. |
| `entitlement-reviews.js` | Same. |
| `webauthn.js` | Passkeys. Nice to have, not blocking revenue. |
| `lora-adapters.js` | Fine-tuning vertical — separate product, no ICP signal. |
| `fine-tuning.js` | Same. |
| `offline-models.js` | Edge AI — defer. |
| `mobile.js`, `mobile-automation.js` | Mobile vertical — separate product. |
| `screen-share.js` | Niche. Defer. |
| `meeting-bot.js` | Separate product. Defer. |
| `data-residency.js` | Enterprise compliance. Defer. |
| `compliance.js` | Enterprise compliance. Defer. |
| `audit-anchor.js`, `audit-verify.js` | Blockchain audit anchoring. Defer. |
| `slo.js` | SLO tracking. Useful but not blocking users. |
| `synthetic.js` | Synthetic monitoring. Defer. |
| `runbooks.js` | On-call automation. Defer. |
| `status-page.js` | Status page automation. Defer. |
| `alertmanager-webhook.js` | Ops infrastructure. Defer. |
| `canary.js` | Canary deployments. Defer. |
| `chaos-engineering.js` | Defer until you need chaos tests in prod. |
| `error-budget.js` | Same. |
| `load-shedding.js` | Same. |
| `degradation-tiers.js` | Same. |
| `crdt.js` | CRDT sync — complex. Defer until collaboration scaling need. |
| `data-warehouse.js` | Warehouse export. Defer until enterprise. |
| `agent-marketplace.js` | Marketplace needs two-sided network. Defer. |
| `recipe-marketplace.js` | Same. |
| `plugin-certification.js` | Same. |
| `developer-portal.js` | Defer until SDK traction. |
| `referrals.js` | Growth loop. Set up after first 50 users. |
| `template-gallery.js` | Content problem. Defer until recipes are popular. |
| `edge-cache.js` | Infrastructure optimization. Defer. |
| `schema-registry.js` | Data engineering. Defer. |
| `data-quality.js` | Same. |
| `schema-evolution.js` | Same. |
| `lineage.js` | Same. |
| `feature-store.js` | Same. |
| `profiling.js`, `heap-diff.js`, `step-latency.js` | Deep perf tooling. Defer. |
| `log-analysis.js` | Log analysis. Defer. |
| `benchmark-runner.js` | ML benchmarks. Defer. |
| `curriculum.js` | ML training curriculum. Defer. |
| `speculative-decoding.js` | Inference optimization. Defer. |
| `quantization.js` | Model quantization. Defer. |
| `distillation.js` | Model distillation. Defer. |
| `cost-aware-router.js` | Smart cost routing. Useful but not blocking. |
| `prompt-compression.js` | Context optimization. Defer. |
| `prompt-evolution.js` | Prompt optimization pipeline. Defer. |
| `tool-discovery.js`, `tool-rag.js`, `tool-disclosure.js`, `tool-validation.js`, `tool-graph.js`, `tool-composition.js` | Meta-tooling. Defer until tool ecosystem exists. |
| `cohort-analysis.js`, `funnels.js`, `dashboards.js`, `anomalies.js` | Analytics platform. Defer. |
| `experiment-bridge.js`, `reproducibility-checks.js` | ML research. Defer. |
| `budget-allocation.js` | Cost management. Defer. |
| `invoicing.js` | Custom invoicing. Use Stripe invoicing until enterprise. |
| `revenue-share.js` | Revenue share program. Defer. |
| `credit-system.js` | Credit economy. Defer. |
| `outcome-verification.js` | Agent outcome tracking. Defer. |
| `agent-negotiation.js` | Multi-agent negotiation. Defer. |
| `long-missions.js` | Long-horizon agent runs. Defer until agents are stable. |
| `agent-consensus.js` | Consensus routing. Defer. |
| `agent-profiles.js` | Agent persona management. Defer. |
| `agent-tools-discover.js` | Tool discovery API. Defer. |
| `agent-sandbox.js` | Sandbox execution env. Defer until code exec is stable. |
| `continuous-learning.js` | Online learning. Defer. |
| `karpathy-pipeline.js` | Research pipeline. Defer. |
| `zero-to-hero.js` | Training pipeline. Defer. |
| `preference-collection.js` | RLHF data collection. Defer. |
| `synthetic-users.js` | Synthetic user simulation. Defer. |
| `judge-calibration.js` | Eval calibration. Defer. |
| `regression-bisection.js` | Eval tooling. Defer. |
| `eval-in-prod.js` | Production eval. Defer until eval pipeline is core. |
| `integration-test-harness.js` | Dev tooling. Defer. |
| `api-playground.js` | Nice-to-have. Defer. |
| `dev-setup.js` | Dev tooling. Defer. |
| `intent-classifier.js` | Support vertical. Defer. |
| `ticket-router.js` | Support vertical. Defer. |
| `response-drafter.js` | Support vertical. Defer. |
| `escalation-rules.js` | Support vertical. Defer. |
| `csat-tracker.js` | Support vertical. Defer. |
| `multi-repo.js` | Multi-repo code management. Defer. |
| `machine-snapshots.js` | Machine snapshotting. Defer. |
| `session-patch.js` | Session patching. Defer. |
| `issue-pickup.js` | Issue auto-assignment. Defer. |
| `desktop-agent.js` | Desktop automation agent. Defer. |
| `test-gen.js`, `refactor-agent.js`, `migration-assistant.js` | Code gen vertical — high value but scope it separately. |
| `literature-search.js`, `paper-summary.js`, `citation-graph.js` | Research vertical — defer. |
| `model-registry.js` | Model management. Defer. |
| `model-approval.js` | Model governance. Defer. |
| `usage-policies.js` | Policy management. Defer. |
| `audit-reports.js` | Compliance reports. Defer. |
| `branding.js` | White-labeling. Defer until enterprise. |
| `service-auth.js` | Service-to-service auth. Defer. |
| `secret-rotation.js` | Secret rotation. Defer. |
| `experiments.js` | A/B testing framework. Defer. |
| `query-analyzer.js` | Query analysis. Defer. |
| `policy-audit.js` | Policy audit. Defer. |
| `risky-ops-quota.js` | Risky ops gating. Defer. |
| `dag-pipeline.js` | DAG pipeline builder. Defer. |
| `web-ingestion.js` | Web crawl ingestion. Defer. |
| `large-retrieval.js` | Large-scale retrieval. Defer. |
| `freshness-sla.js` | Knowledge freshness. Defer. |
| `observability-snapshot.js` | Move to SUPPORTING if needed; otherwise defer. |

---

## DELETE — Remove entirely

These have no plausible path to ICP revenue. Remove from `routes/index.js`,
delete the file, and remove any `lib/` modules that only serve them.

| Module | Reason |
|---|---|
| `xr.js` | XR/VR — zero users, no roadmap path |
| `vr-rooms.js` | Same |
| `avatar-agents.js` | 3D avatar agents — no market signal |
| `spatial-graph.js` | 3D spatial graph — no market signal |
| `gesture-control.js` | Gesture UI — no market signal |
| `3d-assets.js` | 3D asset pipeline — completely out of scope |
| `nft-gating.js` | NFT token gating — crypto feature, no ICP fit |
| `crypto-payments.js` | Crypto payments — Stripe is the strategy |
| `wallet-auth.js` | Web3 wallet login — no ICP fit |
| `decentralized-storage.js` | IPFS/decentralized storage — out of scope |
| `pq-jwt.js` | Post-quantum JWT — research feature |
| `pq-migration.js` | Post-quantum migration — research feature |
| `pq-tls.js` | Post-quantum TLS — research feature |
| `pq-dilithium.js` | Dilithium signature scheme — research feature |
| `pq-kyber.js` | Kyber KEM — research feature |
| `federated-training.js` | Federated ML training — separate research product |
| `fl-consortium.js` | Federated learning consortium — same |
| `privacy-accounting.js` | Differential privacy accounting — same |
| `secure-aggregation.js` | Secure aggregation — same |
| `differential-privacy.js` | Differential privacy — same |
| `gbrain.js` | GBrain meta-learning — research/aspirational |
| `neuro-symbolic.js` | Neuro-symbolic reasoning — research/aspirational |
| `bpe-tokenizer.js` | BPE tokenizer endpoint — not a user-facing feature |
| `preference-datasets.js` | RLHF dataset management — separate ML infra product |
| `jailbreak-detector.js` | Jailbreak detection — integrate as middleware if needed, not a route |
| `constitutional-ai.js` | Constitutional AI — same |
| `bias-eval-suite.js` | Bias evaluation — research/compliance, no ICP fit now |
| `k-anonymous-telemetry.js` | k-anonymity telemetry — research |
| `safety-sla.js` | Safety SLAs — research |
| `red-team-harness.js` | Red team automation — internal tool, not user-facing |
| `model-card-generator.js` | Model cards — ML governance, no ICP fit |
| `self-consistency.js` | Self-consistency decoding — internal routing, not a route |
| `verification-loop.js` | Verification loop — same |
| `tree-of-thought.js` | Tree-of-thought — expose via agent tools, not a route |
| `graph-of-thought.js` | Graph-of-thought — same |
| `video-understanding.js` | Video analysis — scope creep |
| `audio-classification.js` | Audio classification — scope creep |
| `image-generation.js` | Image generation — separate product |
| `output-classifiers.js` | Output classification — integrate as middleware |
| `screen-control.js` | Screen control agent — out of scope for ICP |
| `shell-agent.js` | Shell agent — dangerous, scope it as an opt-in tool not a route |
| `browser-agent.js` | Browser automation — defer to a separate agent tool |
| `document-layout.js` | Document layout analysis — niche |
| `fs-agent.js` | FS agent — redundant with workspace file tools |
| `hash-detection.js` | Hash-based content detection — content moderation platform, not AI assistant |
| `copyright-similarity.js` | Copyright detection — same |
| `factuality-crossref.js` | Factuality cross-reference — research |
| `brand-safety.js` | Brand safety classification — content moderation platform |
| `hitl-moderation.js` | Human-in-the-loop moderation queue — separate product |
| `fact-verification.js` | Fact verification — research |
| `source-credibility.js` | Source credibility scoring — research |
| `ai-risk-scoring.js` | AI risk scoring — governance platform |
| `synthetic-tasks.js` | Synthetic task generation — ML infra |

---

## Summary

| Tier | Count | Action |
|---|---|---|
| CORE | 13 | Keep, ensure tested and live |
| SUPPORTING | ~40 | Keep, ensure tested and live |
| DEFER | ~80 | Return `501 Not Implemented` |
| DELETE | ~50 | Remove from `routes/index.js` and delete files |

**After cleanup:** ~53 active route modules, down from 254.
This is still enough surface area for a fully-featured B2B SaaS product.

---

## How to Execute the Cleanup

1. For each DELETE entry: remove the import and array entry from `routes/index.js`,
   delete the `routes/<module>.js` file, and check if any `lib/` file is exclusively
   used by that route (delete those too).

2. For each DEFER entry: add a stub at the top of the mount function:
   ```js
   export function mountXRoutes(app, deps) {
     app.all('/api/x/*', (req, res) => res.status(501).json({ error: 'NOT_IMPLEMENTED' }));
   }
   ```
   Or remove the import entirely and handle the 501 in a catch-all.

3. Run `npm test` after each batch of deletions to confirm nothing live broke.

4. Do this in a dedicated PR, not mixed with feature work.
