# SiskelBot Roadmap: Phase 71 (next 10 items)

Ten prioritized product items following [ROADMAP_51-70.md](./ROADMAP_51-70.md). Focus: revenue activation, production ops, and agent UX polish.

**Status date:** 2026-07-06

| # | Item | Description | Status |
|---|------|-------------|--------|
| 71.1 | **Stripe live mode** | Production keys, webhook at `POST /api/v1/billing/webhook`, Billing Portal, Pro/Enterprise price IDs ([GO_LIVE.md](./GO_LIVE.md) §1) | Planned |
| 71.2 | **Plan enforcement** | Enable `ENFORCE_PLAN_LIMITS=1` and `QUOTA_ENABLED=1` on Vercel production; verify 402 gates | Planned |
| 71.3 | **Go-live verify automation** | `npm run go-live:verify` probes health, billing, entitlements, account/pricing pages | **Shipped** |
| 71.4 | **Branch protection** | Require lint, test, Trivy, smoke, e2e, agent-regression on `main` (`scripts/apply-branch-protection.mjs`) | Planned |
| 71.5 | **Chaos CI reliability** | Weekly `npm run test:chaos` job green (13 resilience tests under `tests/chaos/`) | **Shipped** |
| 71.6 | **Production smoke on deploy** | Auto-run Production smoke workflow after successful CI on `main` | **Shipped** |
| 71.7 | **Agent Run cost parity** | Swarm + single-agent cumulative `cost.update` in session UI (backend wired @ `07b4188`) | Partial — UI polish |
| 71.8 | **Metered usage → Stripe** | Wire `lib/stripe-metering.js` to chat token spend; admin revenue dashboard | Partial — code landed #69 |
| 71.9 | **Wave-2 agent hooks** | Upfront plan, mid-loop critique, semantic trim, failure memory in `runAgentLoop` | **Shipped** @ `1d158f3` |
| 71.10 | **Deep health synthetics** | External monitor on `/health/deep` dependency matrix | Planned |

---

## Enablers already on `main`

- CI green: budget, upfront plan, swarm cost, tool judge, circuit-breaker flake fix
- Billing dashboard + account page (#69), `docs/GO_LIVE.md`
- `setup:production-env`, `check:production-env`, `go-live:verify`, `test:chaos`

## Suggested order

```text
71.1 → 71.2 → go-live:verify → 71.4 → 71.7/71.8 → 71.10
```

See also [AGENT_WORLD_CLASS_ROADMAP.md](./AGENT_WORLD_CLASS_ROADMAP.md) for agent-capability phases 6–20.
