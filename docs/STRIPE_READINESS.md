# Stripe Live-Mode Readiness Checklist

Status of the billing integration as of May 2026 and exact steps to go live.

---

## Current State

The implementation in `lib/billing.js` and `routes/billing.js` is correct and
production-capable. What's missing is configuration and one missing Stripe
feature (customer portal). Nothing needs to be rewritten.

**What works today (test mode):**
- Usage recording and cost computation (`billing.recordUsage`)
- Usage summaries and invoice generation (`billing.getUsageSummary`, `billing.getInvoice`)
- Plan management — free/pro/enterprise (`lib/plans.js`)
- Stripe Checkout session creation (`createCheckoutSession`)
- Webhook handling for 3 events: `checkout.session.completed`,
  `customer.subscription.updated`, `customer.subscription.deleted`
- Subscription state persistence (JSON file per workspace)
- Plan limit enforcement (`billing.checkPlanLimits`)

---

## Checklist: Required Before Going Live

### 1. Create real Stripe products and prices

In the Stripe Dashboard (live mode):

- [ ] Create product: **SiskelBot Pro** — $29/month recurring
  - Note the price ID (e.g. `price_1ABC...`), set as `STRIPE_PRO_PRICE_ID`
- [ ] Create product: **SiskelBot Pro Annual** — $249/year recurring (optional)
- [ ] Create product: **SiskelBot Enterprise** — contact-us or $299/month
  - Note the price ID, set as `STRIPE_ENTERPRISE_PRICE_ID`

**Why $299 for enterprise, not $99:** The current `lib/plans.js` sets enterprise
at $99/month with unlimited tokens. Real enterprise buyers expect $500–2,000/month
for unlimited usage with SSO and audit trails. Fix before any enterprise outreach.
Update `lib/plans.js`:
```js
enterprise: {
  priceMonthly: 299,  // was 99 — still low, raise again when enterprise demand exists
  ...
}
```

---

### 2. Set environment variables (live mode)

```bash
STRIPE_SECRET_KEY=sk_live_...           # Live secret key from Stripe Dashboard
STRIPE_WEBHOOK_SECRET=whsec_...         # From webhook endpoint setup (step 4)
STRIPE_PRO_PRICE_ID=price_...           # Live price ID for Pro plan
STRIPE_ENTERPRISE_PRICE_ID=price_...    # Live price ID for Enterprise plan
```

**Never commit these values.** Use a secrets manager or deployment environment
variables. The `.env.example` already has the correct placeholder names.

---

### 3. Register the webhook endpoint in Stripe Dashboard

- [ ] Go to Stripe Dashboard → Developers → Webhooks → Add endpoint
- [ ] Endpoint URL: `https://your-domain.com/api/v1/billing/webhook`
- [ ] Select events to listen for:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
- [ ] Copy the signing secret → set as `STRIPE_WEBHOOK_SECRET`

**Note:** The webhook handler in `routes/billing.js` correctly uses
`express.raw({ type: "application/json" })` before the handler. This is
required for Stripe signature verification. Do not add `express.json()` to
this route.

---

### 4. Add customer email to Checkout sessions

**Current issue in `lib/billing.js:324`:** The checkout session does not
collect or pass the customer email. If a user's workspace is not yet a Stripe
customer, Stripe creates an anonymous session. This makes it hard to match
invoices to users later.

**Fix** — update `createCheckoutSession` to accept and forward the user's email:

```js
// In lib/billing.js — createCheckoutSession
export async function createCheckoutSession({ workspaceId, userId, planId, successUrl, cancelUrl, userEmail }) {
  // ...
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.priceId, quantity: 1 }],
    metadata: { workspaceId, userId, planId },
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(userEmail ? { customer_email: userEmail } : {}),
  });
  // ...
}
```

And update `routes/billing.js` to pass `req.user?.email` (or however the
authenticated user's email is available in `req`):

```js
// In routes/billing.js — POST /api/v1/billing/checkout
const { planId, successUrl, cancelUrl, workspaceId: bodyWs } = req.body || {};
const userEmail = req.user?.email || req.userEmail || undefined;
const result = await createCheckoutSession({ workspaceId, userId, planId, successUrl, cancelUrl, userEmail });
```

---

### 5. Add a Stripe Customer Portal route

**Current gap:** There is no way for users to manage their subscription
(cancel, update payment method, view invoices) without contacting you. Stripe
provides a hosted portal for this.

**Add to `routes/billing.js`:**

```js
// POST /api/v1/billing/portal — create a Stripe billing portal session
apiRoute("post", "/billing/portal", userAuth, logRequest, async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return apiError(res, 503, "STRIPE_DISABLED", "Stripe is not configured");
  }
  const workspaceId = sanitizeWorkspace(req.body?.workspaceId || "default");
  const returnUrl = req.body?.returnUrl;
  if (!returnUrl) {
    return apiError(res, 400, "INVALID_INPUT", "returnUrl is required");
  }
  try {
    const subscription = await getWorkspaceSubscription(workspaceId);
    if (!subscription.stripeCustomerId) {
      return apiError(res, 404, "NO_SUBSCRIPTION", "No Stripe customer found for this workspace");
    }
    const stripe = getStripe(); // need to export this from lib/billing.js or inline
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: returnUrl,
    });
    res.json({ url: session.url });
  } catch (err) {
    return apiError(res, 500, "INTERNAL_ERROR", err.message);
  }
});
```

**Also required:** Enable the Customer Portal in Stripe Dashboard → Settings →
Billing → Customer portal. Configure what users can do (cancel, update card,
view invoices).

---

### 6. Store workspaceId on the Stripe Subscription metadata

**Current gap:** The `customer.subscription.updated` webhook handler at
`lib/billing.js:367` relies on `sub.metadata?.workspaceId` being present on
the subscription object. This is only set if it was included at subscription
creation time.

**Fix** — pass metadata when creating the checkout session:

```js
// Already present in lib/billing.js:324 — verify this is correct
const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  subscription_data: {
    metadata: { workspaceId, userId, planId },  // ADD THIS
  },
  line_items: [{ price: plan.priceId, quantity: 1 }],
  metadata: { workspaceId, userId, planId },    // keeps session-level metadata too
  ...
});
```

Without `subscription_data.metadata`, the subscription object itself will not
carry `workspaceId` in its metadata, so `customer.subscription.updated` and
`customer.subscription.deleted` will silently no-op.

---

### 7. End-to-end test in Stripe test mode before flipping to live

Use Stripe's test card numbers to verify the full flow:

- [ ] `POST /api/v1/billing/checkout` returns a valid URL
- [ ] Completing checkout in Stripe's hosted UI triggers `checkout.session.completed`
- [ ] Webhook correctly writes plan=`pro` and status=`active` to the workspace subscription file
- [ ] `GET /api/v1/billing/subscription` returns the updated state
- [ ] `GET /api/v1/billing/plan` reflects the upgraded plan
- [ ] Canceling in the portal triggers `customer.subscription.deleted`
- [ ] Webhook correctly writes plan=`free` and status=`canceled`
- [ ] `billing.checkPlanLimits` correctly gates requests after cancel

Use `stripe listen --forward-to localhost:3000/api/v1/billing/webhook` during
local testing to forward events to your dev server.

---

### 8. Handle quota enforcement at the API layer

**Current gap:** `billing.checkPlanLimits` exists but it is not called in the
chat completion route (`routes/chat.js`). Users on the free plan can exceed
100K tokens/month with no enforcement.

**Fix:** In `routes/chat.js` (or the middleware layer), check limits before
forwarding the request:

```js
// Pseudocode — check before proxying to LLM backend
if (process.env.QUOTA_ENABLED === "1") {
  const limits = await billing.checkPlanLimits(workspaceId);
  if (!limits.allowed) {
    return apiError(res, 429, "QUOTA_EXCEEDED",
      `Token quota exceeded for plan ${limits.planName}. Used: ${limits.used}, Limit: ${limits.limit}`
    );
  }
}
```

Without this, the free plan's 100K token limit is documented but not enforced.

---

### 9. Set success and cancel URL defaults

**Current gap:** `successUrl` and `cancelUrl` are required by the checkout
route but have no server-side defaults. If the client doesn't send them, the
API returns a 400 error. Define sensible defaults:

```js
// In routes/billing.js
const successUrl = req.body?.successUrl || `${process.env.APP_BASE_URL || ''}/billing/success`;
const cancelUrl  = req.body?.cancelUrl  || `${process.env.APP_BASE_URL || ''}/billing/cancel`;
```

Add `APP_BASE_URL=https://your-domain.com` to `.env.example`.

---

### 10. Add a pricing page to the client UI

**Current gap:** `GET /api/v1/billing/plans` works and returns plan data, but
there is no pricing page in `client/`. Users cannot discover or upgrade their
plan from the UI.

- [ ] Create `client/pricing.html` with a 3-column plan comparison (Free / Pro / Enterprise)
- [ ] Wire "Upgrade" buttons to `POST /api/v1/billing/checkout`
- [ ] Link to it from `client/index.html` (top nav or settings page)

---

## Go-Live Checklist Summary

| # | Item | File(s) | Effort |
|---|---|---|---|
| 1 | Create live Stripe products + prices | Stripe Dashboard | 30 min |
| 2 | Set live env vars | `.env` / deployment config | 5 min |
| 3 | Register webhook endpoint in Stripe | Stripe Dashboard | 10 min |
| 4 | Pass `customer_email` to checkout | `lib/billing.js`, `routes/billing.js` | 20 min |
| 5 | Add Customer Portal route | `routes/billing.js` | 30 min |
| 6 | Add `subscription_data.metadata` | `lib/billing.js` | 10 min |
| 7 | End-to-end test with Stripe CLI | Local dev | 60 min |
| 8 | Enforce quota in chat route | `routes/chat.js` | 30 min |
| 9 | Default success/cancel URLs | `routes/billing.js`, `.env.example` | 10 min |
| 10 | Add pricing page to client | `client/pricing.html` | 60–90 min |

**Total estimated effort: ~5 hours** to go from test keys to a working live
billing flow with a pricing page.

---

## What Does NOT Need to Change

- The webhook signature verification in `routes/billing.js` — it is correct
- The `express.raw()` usage for the webhook route — it is correct
- The plan definitions in `lib/plans.js` (except enterprise price)
- The token usage recording and cost computation logic
- The Stripe API version (`2025-03-31.basil`) — it is current
