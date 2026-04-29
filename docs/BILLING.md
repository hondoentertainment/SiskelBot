# Stripe Billing Integration

SiskelBot uses Stripe for paid plan checkout and subscription lifecycle management. The integration is opt-in: if `STRIPE_SECRET_KEY` is not set, all Stripe functions silently return no-ops so the server starts without billing configured.

## Plan Tiers

| Plan | Requests/min | Tokens/day | Price |
|---|---|---|---|
| Free | 10 | 100,000 | $0 |
| Pro | 60 | 1,000,000 | Set in Stripe dashboard |
| Enterprise | 300 | 10,000,000 | Set in Stripe dashboard |

Prices are managed entirely in the Stripe dashboard. The server references them by Price ID via `STRIPE_PRO_PRICE_ID` and `STRIPE_ENTERPRISE_PRICE_ID`.

## Environment Variables

```
STRIPE_SECRET_KEY=sk_test_...           # Stripe secret key
STRIPE_WEBHOOK_SECRET=whsec_...         # Webhook signing secret (from Stripe dashboard)
STRIPE_PRO_PRICE_ID=price_...           # Price ID for the Pro plan
STRIPE_ENTERPRISE_PRICE_ID=price_...    # Price ID for the Enterprise plan
```

## API Endpoints

### `GET /api/v1/billing/plans`
Public. Returns the available plan catalog including Stripe plan metadata.

### `GET /api/v1/billing/subscription`
Auth required. Returns the current Stripe subscription state for the workspace.

Query params:
- `workspace` — workspace ID (defaults to `"default"`)

Response:
```json
{
  "workspaceId": "my-workspace",
  "subscription": {
    "plan": "pro",
    "status": "active",
    "stripeCustomerId": "cus_...",
    "stripeSubscriptionId": "sub_...",
    "updatedAt": "2026-04-29T00:00:00.000Z"
  }
}
```

### `POST /api/v1/billing/checkout`
Auth required. Creates a Stripe Checkout Session for upgrading a workspace.

Request body:
```json
{
  "planId": "pro",
  "workspaceId": "my-workspace",
  "successUrl": "https://your-app.com/billing/success",
  "cancelUrl": "https://your-app.com/billing/cancel"
}
```

Response:
```json
{
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_..."
}
```

Redirect the user to `url` to complete payment.

### `POST /api/v1/billing/webhook`
No auth. Receives Stripe webhook events. The raw request body is required for signature verification — do not apply `express.json()` to this route.

Handled events:
- `checkout.session.completed` — activates the subscription for the workspace
- `customer.subscription.updated` — updates plan tier and status
- `customer.subscription.deleted` — downgrades to free plan

## Stripe Webhook Setup

1. In the Stripe dashboard, go to **Developers → Webhooks → Add endpoint**.
2. Set the endpoint URL to `https://your-domain.com/api/v1/billing/webhook`.
3. Subscribe to these events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the **Signing secret** and set it as `STRIPE_WEBHOOK_SECRET` in your environment.

## Testing in Development

Use the Stripe CLI to forward events to your local server:

```bash
stripe listen --forward-to localhost:3000/api/v1/billing/webhook
```

The CLI prints a webhook signing secret (`whsec_...`). Set that as `STRIPE_WEBHOOK_SECRET` for local testing.

Trigger test events:

```bash
# Simulate a completed checkout
stripe trigger checkout.session.completed

# Simulate subscription update
stripe trigger customer.subscription.updated

# Simulate subscription cancellation
stripe trigger customer.subscription.deleted
```

## Plan Upgrade Flow

1. The user selects a plan from the plans page (which calls `GET /api/v1/billing/plans`).
2. The client calls `POST /api/v1/billing/checkout` with `planId`, `successUrl`, and `cancelUrl`.
3. The server creates a Stripe Checkout Session and returns the session URL.
4. The client redirects the user to the Stripe-hosted checkout page.
5. After payment, Stripe sends a `checkout.session.completed` webhook.
6. The webhook handler activates the subscription in storage (key `billing-subscriptions/<workspaceId>.json`).
7. The user is redirected to `successUrl` and can immediately use the upgraded plan.

Subscription state is readable at any time via `GET /api/v1/billing/subscription`.
