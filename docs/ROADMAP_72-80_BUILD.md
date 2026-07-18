# SiskelBot Roadmap: Phases 72–80 (build-out)

Status date: 2026-07-18. Implements the product build-out from [NEXT_PHASES.md](./NEXT_PHASES.md).

| Phase | Focus | Status |
|------|--------|--------|
| **72** | Trust & Safety Pro | **Shipped** — routes + `/admin-ops.html` (red-team, safety-sla, bias, judge, prefs) |
| **73** | Agent Reliability | **Shipped** — fuzz, stagnation, trajectory anomaly, post-mortem; failure re-plan capped (`AGENT_REPLAN_ON_FAILURE`, `AGENT_MAX_REPLANS`) |
| **74** | Memory 2.0 | **Shipped** — inject + conflict hints + procedural learn/match in agent loop; `/memory-editor.html` conflicts + procedures |
| **75** | Evaluation 2.0 | **Shipped** — judge calibration, preferences UI, bisection, synthetic users |
| **76** | Edge & Offline | **Partial** — CRDT + offline-models routes; WebLLM/delta sync still open |
| **77** | Integrations Breadth | **Partial** — OAuth/integrations; CRM connectors still open |
| **78** | Governance UX | **Partial** — ISO 27001 report + compliance tab; legal-hold API + `/legal-hold.html`; PAM/visual policy builder depth open |
| **79** | Platform | **Partial** — embed → `/v1/chat/completions` bridge (`widget.js` + `frame.html`); BYOK/Connect open |
| **80** | Model Lifecycle | **Partial** — `/model-lifecycle.html` (registry/canary/error-budget/deprecations); `MODEL_PROMOTION_GATE=1` supported |

## Client surfaces

- `/admin-ops.html` — trust/safety/eval ops shell
- `/preferences.html`, `/memory-editor.html`, `/legal-hold.html`, `/model-lifecycle.html`, `/compliance.html` (ISO 27001 tab)
- `/embed/widget.js`, `/embed/frame.html` — hostable chat iframe

## Agent / safety wiring

- Memory inject (`AGENT_MEMORY_INJECT`), procedural hints (`AGENT_PROCEDURAL_HINT`), conflict hints (`AGENT_MEMORY_CONFLICT_HINT`), learn on complete (`AGENT_LEARN_PROCEDURES`)
- Browser new-domain HITL (`AGENT_BROWSER_HITL_NEW_DOMAINS=1`) when host is not in workspace `browserAllowedHosts`
- Legal hold blocks retention enforce (`POST /api/v1/workspaces/:id/legal-hold`)

## Remaining (operator / large)

- **Stripe live (71.1)** — requires dashboard keys (`STRIPE_SECRET_KEY`, webhook, price IDs)
- **Dedicated Neon** — stop sharing `neon-citrine-castle` (KV table already namespaced via `STORAGE_KV_TABLE`)
- **LLM backend** — so `/health/deep` is healthy, not degraded
- WebLLM client inference, full CRM connectors, Stripe Connect, BYOK data plane, visual policy builder depth

See also [ROADMAP_71-80.md](./ROADMAP_71-80.md) and [AGENT_WORLD_CLASS_ROADMAP.md](./AGENT_WORLD_CLASS_ROADMAP.md).
