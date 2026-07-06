# SiskelBot Roadmap: Phase 71 (next 10 items)

Ten prioritized product items following [ROADMAP_51-70.md](./ROADMAP_51-70.md). Focus: revenue activation, production ops, and agent UX polish.

**Status date:** 2026-07-06

| # | Item | Description | Status |
|---|------|-------------|--------|
| 71.1 | **Stripe live mode** | Production keys, webhook at `POST /api/v1/billing/webhook`, Billing Portal, Pro/Enterprise price IDs ([GO_LIVE.md](./GO_LIVE.md) §1) | Planned (Vercel/Stripe dashboard) |
| 71.2 | **Plan enforcement** | Enable `ENFORCE_PLAN_LIMITS=1` and `QUOTA_ENABLED=1` on Vercel production; verify 402 gates | Planned (Vercel env) |
| 71.3 | **Go-live verify automation** | `npm run go-live:verify` probes health, billing, entitlements, account/pricing pages | **Shipped** |
| 71.4 | **Branch protection** | Require lint, test, Trivy, smoke, e2e, agent-regression on `main` | **Shipped** |
| 71.5 | **Chaos CI reliability** | Weekly `npm run test:chaos` job green (13 resilience tests under `tests/chaos/`) | **Shipped** |
| 71.6 | **Production smoke on deploy** | Auto-run Production smoke after successful CI on `main` | **Shipped** |
| 71.7 | **Agent Run cost parity** | Footer shows monotonic USD + token totals from `cost.update`; model in tooltip | **Shipped** |
| 71.8 | **Metered usage → Stripe** | Agent/swarm runs flush cost accumulator → `billing.recordUsage` → Stripe meter | **Shipped** |
| 71.9 | **Wave-2 agent hooks** | Upfront plan, mid-loop critique, semantic trim, failure memory in `runAgentLoop` | **Shipped** |
| 71.10 | **Deep health synthetics** | Weekly `Deep health synthetic` workflow + `/health/deep` optional backend on Vercel | **Shipped** |

---

## Enablers on `main`

- CI green; billing dashboard + account page (#69); `docs/GO_LIVE.md`
- `setup:production-env`, `check:production-env`, `go-live:verify`, `go-live:verify:strict`, `test:chaos`
- Client 402 `PLAN_UPGRADE_REQUIRED` → pricing CTA in chat

## Suggested operator order

```text
71.1 → 71.2 → go-live:verify:strict → confirm production revenue path
```

See also [AGENT_WORLD_CLASS_ROADMAP.md](./AGENT_WORLD_CLASS_ROADMAP.md) for agent-capability phases 6–20.
