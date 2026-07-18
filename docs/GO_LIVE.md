# Go-Live Checklist — turning the shipped commercial product ON

Everything below already exists in the codebase and is **default-off**. This
is the operator checklist that turns SiskelBot from "commercially ready code"
into a live, selling product. Work top to bottom; each item lists the exact
config and how to verify it.

Status date: 2026-07-06

**Automation:** `npm run setup:production-env` · `npm run apply:production-env` · `npm run go-live:verify -- <BASE_URL>` · `npm run go-live:verify:strict -- <BASE_URL>` (after flags) · `npm run branch-protection:apply`

---

## 1. Stripe billing

Set in the production environment (Vercel → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | Live secret key (`sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the webhook below |
| `STRIPE_PRO_PRICE_ID` | Price ID for Pro ($29/mo) |
| `STRIPE_ENTERPRISE_PRICE_ID` | Price ID for Enterprise |
| `APP_BASE_URL` | Public origin, e.g. `https://your-domain.com` |

In the Stripe Dashboard:

- [ ] Create Products/Prices for Pro and Enterprise matching `lib/plans.js`
      (`priceMonthly`: 29 / 299).
- [ ] Add a webhook endpoint pointing at `POST /api/v1/billing/webhook`
      subscribed to `checkout.session.completed`,
      `customer.subscription.updated`, `customer.subscription.deleted`.
- [ ] Enable the customer Billing Portal (used by `POST /api/v1/billing/portal`).

**Verify:** `/pricing.html` → "Upgrade to Pro" completes checkout in test mode;
`GET /api/v1/billing/subscription?workspace=X` shows `status: active`;
`GET /api/v1/entitlements?workspace=X` shows the paid plan.

## 2. Plan enforcement (make free vs. paid real)

| Variable | Effect |
|---|---|
| `ENFORCE_PLAN_LIMITS=1` | Seat caps at invite-join; feature gates (e.g. workflows are Pro+) return 402 `PLAN_UPGRADE_REQUIRED` |
| `QUOTA_ENABLED=1` | Monthly token caps per plan enforced in `/v1/chat/completions` (free 100K/mo, pro 1M/mo) |

Both fail open on internal errors — a bug can never block paying customers.

**Verify:** on a free workspace, add 3 members then a 4th → 402; call a
workflows endpoint → 402; `GET /api/v1/entitlements` shows `"enforced": true`.

## 3. Trials (conversion funnel)

Optional overrides: `TRIAL_DEFAULT_PLAN` (default `pro`),
`TRIAL_DEFAULT_DAYS` (default `14`).

Nothing to enable — `/account.html` offers "Start free trial" on free
workspaces; one trial per workspace; reverts automatically at expiry.

## 4. Proactive coworker (initiative engine)

| Variable | Effect |
|---|---|
| `ENABLE_SCHEDULED_RECIPES=1` | Starts the in-process scheduler (leader-gated) |
| `ENABLE_INITIATIVE_ENGINE=1` | Periodic observe→propose cycles |
| `INITIATIVE_CRON` | Cadence (default `*/15 * * * *`) |
| `INITIATIVE_WORKSPACES` | Comma-separated workspaces (default `default`) |
| `INITIATIVE_NOTIFY_SLACK=1` + `INITIATIVE_SLACK_CHANNEL` | Surface proposals in Slack with Approve/Dismiss buttons |

In the Slack app config:

- [ ] Interactivity & Shortcuts → Request URL:
      `https://your-domain.com/api/v1/integrations/slack/interactions`
      (signature-verified with the existing `SLACK_SIGNING_SECRET`).

**Verify:** `POST /api/v1/initiatives/run` returns proposals for a workspace
with failing scheduled agents; buttons in Slack resolve them.

## 5. Cost controls

| Variable | Effect |
|---|---|
| `WORKSPACE_BUDGET_USD` | Default per-workspace spend cap (0 = unlimited) |
| `COST_BUDGET_PERIOD` | `month` (default) or `day` |
| `MODEL_PROMOTION_GATE` | `1` to require golden-trace gate on model promote/status |
| `STORAGE_KV_TABLE` | Postgres KV table name (prod: `siskelbot_storage_kv`) |

Per-workspace caps: `PUT /api/v1/cost-budget` (admin).
Scheduled agents refuse to run (`budget_exceeded`) once a workspace is over cap.

Applied on production (2026-07-18): `WORKSPACE_BUDGET_USD=50`, `COST_BUDGET_PERIOD=month`, `MODEL_PROMOTION_GATE=1`, `STORAGE_KV_TABLE=siskelbot_storage_kv`.

## 6. Repository protection (GitHub — one-time)

Red CI checks currently do **not** block merging. Apply
[docs/BRANCH_PROTECTION.md](./BRANCH_PROTECTION.md) to `main`: require the
`lint`, `test`, `Trivy`, and `Analyze (javascript-typescript)` checks and at
least the `regression` gate before merge.

## 7. Production baseline (from docs/NEXT_STEPS.md — unchanged)

- [x] `API_KEY`, `ADMIN_API_KEY`, `SESSION_SECRET` — applied via `npm run apply:production-env` (2026-07-13)
- [x] Durable storage (`STORAGE_BACKEND=postgres` + `DATABASE_URL` from Neon store
      `neon-citrine-castle`) and `REQUIRE_DURABLE_STORAGE=1`
- [x] `ENFORCE_PLAN_LIMITS=1`, `QUOTA_ENABLED=1`, `APP_BASE_URL`, `HEALTH_DEEP_BACKEND_OPTIONAL=1`
- [ ] Stripe live keys (`STRIPE_*`) — still required for checkout

`npm run setup:production-env` prints the exact commands; prefer `npm run apply:production-env` for non-interactive apply.
`npm run setup:stripe-products -- --apply` creates Pro/Enterprise prices when `STRIPE_SECRET_KEY` is set.

---

## Quick smoke after flipping flags

```bash
BASE=https://your-domain.com
npm run go-live:verify -- $BASE
curl -s $BASE/api/v1/entitlements?workspace=default | jq .enforced   # true when enabled
curl -s $BASE/api/v1/billing/plans | jq '.plans | length'            # 3
npm run smoke-test:ci                                                # green (local or CI)
```
