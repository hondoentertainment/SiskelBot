/**
 * Stripe metered billing — report token usage to a Stripe Billing Meter so
 * usage-based prices can bill on it. Entirely env-gated and best-effort: when
 * STRIPE_METER_EVENT_NAME is unset (or Stripe is disabled, or the workspace
 * has no Stripe customer) this module is a silent no-op, so fixed-price
 * deployments are unaffected.
 *
 * Config:
 *   STRIPE_METER_EVENT_NAME   Meter event name from the Stripe dashboard
 *                             (Billing → Meters), e.g. "siskelbot_tokens".
 *   STRIPE_METER_UNIT         "token" (default) or "1k_tokens" — the value
 *                             unit posted per event.
 *
 * The operator attaches a metered Price to that meter in Stripe; this module
 * only reports consumption (stripe.billing.meterEvents.create).
 */
import { getWorkspaceSubscription } from "./billing.js";

let _stripe;
async function getStripeAsync() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const mod = await import("stripe");
    const Stripe = mod.default || mod.Stripe;
    _stripe = new Stripe(key);
    return _stripe;
  } catch {
    return null;
  }
}

export function isMeteringEnabled() {
  return Boolean(process.env.STRIPE_METER_EVENT_NAME && process.env.STRIPE_SECRET_KEY);
}

/**
 * Report token consumption for a workspace to the configured Stripe meter.
 * Silent no-op unless metering is enabled AND the workspace has a Stripe
 * customer. Never throws.
 *
 * @param {string} workspaceId
 * @param {number} totalTokens
 * @returns {Promise<{ reported: boolean, reason?: string, value?: number }>}
 */
export async function reportMeteredUsage(workspaceId, totalTokens) {
  try {
    if (!isMeteringEnabled()) return { reported: false, reason: "disabled" };
    const tokens = Math.max(0, Number(totalTokens) || 0);
    if (tokens === 0) return { reported: false, reason: "zero" };

    const sub = await getWorkspaceSubscription(workspaceId);
    if (!sub.stripeCustomerId) return { reported: false, reason: "no_customer" };
    // Only meter live subscriptions (past_due is still an open subscription);
    // canceled workspaces must not keep generating billable events.
    if (sub.status !== "active" && sub.status !== "past_due") {
      return { reported: false, reason: "inactive" };
    }

    const unit = (process.env.STRIPE_METER_UNIT || "token").toLowerCase();
    const value = unit === "1k_tokens" ? Math.ceil(tokens / 1000) : tokens;

    const stripe = await getStripeAsync();
    if (!stripe) return { reported: false, reason: "stripe_unavailable" };

    await stripe.billing.meterEvents.create({
      event_name: process.env.STRIPE_METER_EVENT_NAME,
      payload: {
        stripe_customer_id: sub.stripeCustomerId,
        value: String(value),
      },
    });
    return { reported: true, value };
  } catch (err) {
    console.warn("[stripe-metering] meter event failed:", err?.message || err);
    return { reported: false, reason: "error" };
  }
}

/** Test helper — reset the cached client. */
export function __resetStripeForTests() {
  _stripe = undefined;
}
