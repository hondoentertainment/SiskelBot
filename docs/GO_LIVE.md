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

## 4b. Advice companion + scheduled agents

| Variable | Effect |
|---|---|
| `ADVICE_BRIEF_CRON` | Cron for morning brief agent (default `0 8 * * *`) |
| `SCHEDULED_AGENT_WORKSPACES` | Workspaces scanned on `/api/cron` (falls back to `INITIATIVE_WORKSPACES`) |
| `AGENT_GOOGLE_WORKSPACE=1` | Expose Gmail/Calendar tools |
| `GOOGLE_WORKSPACE_ACCESS_TOKEN` | Fallback token when a user has not connected their own account |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client so each user can connect Gmail + Calendar |
| `GOOGLE_WORKSPACE_CALLBACK_URL` | Optional. Default `{BASE_URL}/api/v1/google/workspace/callback` |
| `GOOGLE_WORKSPACE_WRITE_SCOPES=1` | Also request send/create scopes (default: readonly) |
| `AGENT_GOOGLE_HITL=0` | Disable HITL for send/create (default: HITL on) |

**UI:** `/advice.html` — Enable mode, journal, **Preview / Schedule daily** morning brief, **Connect Google**, install PWA.
Each signed-in user stores an OAuth token in the secrets store (`user` / `google_workspace_oauth`). The brief and Gmail/Calendar tools use that token and fall back to `GOOGLE_WORKSPACE_ACCESS_TOKEN`. Readonly scopes are the default. In Google Cloud Console, add the workspace callback as an authorized redirect URI. This is separate from the login callback at `/auth/google/callback`.
The brief is journal-only until a user token or the env fallback is present; then preview and the daily run include today's calendar (UTC day) and unread mail from the last two days. Each user gets their own schedule (`ownerUserId`). A legacy schedule with an empty owner can be claimed once; a second user does not replace an owner who is already set. Each run rebuilds that owner's prompt, and calendar, mail, and the closing instructions stay inside the 10k prompt cap.
When a scheduled run finishes, `GET /api/v1/advice/brief/latest` shows that recommendation on `/advice.html`. Email, push, and Slack are off until the user opts in (`PUT /api/v1/advice/brief/delivery`). Email needs `SMTP_HOST` and an address. Push needs a registered device. Slack needs `SLACK_BOT_TOKEN` or `SLACK_WEBHOOK_URL`.
**Verify:** `GET /api/v1/google/workspace/status` (no token in the body), `GET /api/v1/advice/brief` (`sources.googleConnected`, `calendar`, `inbox`), `POST /api/v1/advice/brief/schedule`, then `/api/cron` after `nextRun`, then `GET /api/v1/advice/brief/latest`.

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
- [ ] Dedicated Neon database (prod still shares `neon-citrine-castle`; KV namespaced via `STORAGE_KV_TABLE`)
- [ ] LLM backend credentials so `/health/deep` is healthy (not only degraded-optional)

`npm run setup:production-env` prints the exact commands; prefer `npm run apply:production-env` for non-interactive apply.
`npm run setup:stripe-products -- --apply` creates Pro/Enterprise prices when `STRIPE_SECRET_KEY` is set.
`npm run seed:preferences` seeds pairwise preference cases for `/preferences.html`.
`npm run export:model-card -- <modelId>` exports admin model-card markdown.

---

## Quick smoke after flipping flags

```bash
BASE=https://your-domain.com
npm run go-live:verify -- $BASE
curl -s $BASE/api/v1/entitlements?workspace=default | jq .enforced   # true when enabled
curl -s $BASE/api/v1/billing/plans | jq '.plans | length'            # 3
npm run smoke-test:ci                                                # green (local or CI)
```
