# SiskelBot Roadmap: Phases 72–80 (build-out)

Status date: 2026-07-17. Implements the product build-out from [NEXT_PHASES.md](./NEXT_PHASES.md).

| Phase | Focus | Status |
|------|--------|--------|
| **72** | Trust & Safety Pro | **Shipped** — routes mounted (`red-team`, `model-card`, `bias-eval`, `k-telemetry`, `safety-sla`) |
| **73** | Agent Reliability | **Shipped** — fuzz, stagnation patterns, trajectory anomaly, post-mortem APIs |
| **74** | Memory 2.0 | **Shipped** — decay ranking, conflicts API, procedural memory, PATCH + `memory-editor.html` |
| **75** | Evaluation 2.0 | **Shipped** — judge calibration, preferences (+ UI), bisection, synthetic users mounted |
| **76** | Edge & Offline | **Partial** — CRDT + offline-models routes mounted; WebLLM/delta sync still open |
| **77** | Integrations Breadth | **Partial** — existing OAuth/integrations; CRM connectors still open |
| **78** | Governance UX | **Partial** — constitutional AI, GDPR, entitlement reviews, compliance mounted |
| **79** | Platform | **Partial** — embed widget (`/embed/widget.js`, `frame.html`); BYOK/Connect open |
| **80** | Model Lifecycle | **Partial** — registry/approval/canary/error-budget mounted; promotion gate + deprecation scheduler |

## New / mounted surfaces

- Admin: `/api/v1/red-team/*`, `/model-cards`, `/bias-eval`, `/k-telemetry`, `/judge-calibration`, `/preference/*`, `/regression-bisection`, `/synthetic-users`, `/agent-fuzz/*`, `/trajectory-anomaly/*`, `/post-mortem`, `/model-deprecations`
- User: `/api/v1/procedural-memory/*`, `PATCH /memory/:id`, `GET /memory/conflicts`
- Client: `/preferences.html`, `/memory-editor.html`, `/embed/widget.js`

## Remaining (operator / large)

- Stripe live (71.1) — still requires dashboard keys
- Dedicated Neon for siskelbot (shared store today; KV table namespaced)
- WebLLM client inference, full CRM connectors, Stripe Connect, BYOK data plane

See also [ROADMAP_71-80.md](./ROADMAP_71-80.md) and [AGENT_WORLD_CLASS_ROADMAP.md](./AGENT_WORLD_CLASS_ROADMAP.md).
