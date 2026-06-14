# Design-partner burn-in (Phase 63)

Checklist for validating the code-gen vertical before partner onboarding.

## Automated checks

```bash
# Local (server running)
BACKEND=ollama API_KEY=ci-smoke-key ADMIN_API_KEY=e2e-admin-key npm start
npm run partner-check -- http://127.0.0.1:3000

# E2E golden path
ADMIN_API_KEY=e2e-admin-key npm run test:e2e:api -- tests/e2e/phase63-golden-path.spec.js
```

## Feature flags

| Flag / setting | Purpose |
|----------------|---------|
| `PR_REVIEW_HITL=1` | PR reviews stay in `draft` until approved |
| `requireApproval: true` | Per-request HITL on PR review API |
| Eval-in-prod `qualitySignal` metadata | Shadow samples via `recordPhase63QualitySample` |

## Eval-in-prod alerting

```bash
GET /api/v1/eval-in-prod/alerts?workspaceId=default
GET /api/v1/eval-in-prod/alerts?workspaceId=default&dispatch=1   # POST webhook if firing
```

| Env | Default | Purpose |
|-----|---------|---------|
| `EVAL_IN_PROD_MIN_JACCARD` | 0.7 | Alert when window avg below threshold |
| `EVAL_IN_PROD_MIN_IDENTICAL_RATIO` | 0.5 | Alert on divergence rate |
| `EVAL_IN_PROD_MIN_SAMPLES` | 5 | Minimum samples before alerting |
| `EVAL_IN_PROD_ALERT_WEBHOOK` | — | Slack/Discord/PagerDuty URL |

## Cost metering

Default pricing: **`lib/phase63-pricing.js`** ($0.01/call). Customize via pricing-engine API. Usage lands in `usage.json` + eval-history.

## Manual partner steps

1. Enable HITL for one workspace; run PR review → approve flow.
2. Seed safety SLA: `npm run seed:safety-sla -- --workspace <id>`
3. Run staging drill: set `vars.STAGING_URL`, enable `staging-drill.yml`
4. Set production env: `npm run setup:production-env`

See [docs/PRODUCTION.md](./PRODUCTION.md).
