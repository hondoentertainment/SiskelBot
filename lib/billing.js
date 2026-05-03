/**
 * Phase 24: Monetization & Multi-Tenancy — Usage-based billing system.
 * Tracks token consumption per workspace, computes cost breakdowns,
 * enforces plan limits, and generates invoice data.
 *
 * Wave 18A: Stripe checkout, subscription management, and webhook handling.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";
import { getPlan } from "./plans.js";
import Stripe from "stripe";

const COST_PER_1K_INPUT = Number(process.env.BILLING_COST_PER_1K_INPUT) || 0.002;
const COST_PER_1K_OUTPUT = Number(process.env.BILLING_COST_PER_1K_OUTPUT) || 0.006;
const MAX_USAGE_RECORDS = 200_000;

function billingPath() {
  return join(getDataDir(), "billing-usage.json");
}

/** In-memory cache of billing records, lazily loaded from disk. */
let _records = null;

async function ensureRecords() {
  if (_records === null) {
    const data = await readJsonPath(billingPath(), { _version: 1, records: [] });
    _records = Array.isArray(data.records) ? data.records : [];
  }
  return _records;
}

async function persistRecords() {
  if (_records === null) return;
  const trimmed = _records.length > MAX_USAGE_RECORDS ? _records.slice(-MAX_USAGE_RECORDS) : _records;
  _records = trimmed;
  await writeJsonPath(billingPath(), { _version: 1, records: trimmed });
}

/**
 * Compute cost for a usage record.
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} [model]
 * @returns {number}
 */
function computeCost(inputTokens, outputTokens, model) {
  const input = Math.max(0, inputTokens || 0);
  const output = Math.max(0, outputTokens || 0);
  return Math.round(((input / 1000) * COST_PER_1K_INPUT + (output / 1000) * COST_PER_1K_OUTPUT) * 10000) / 10000;
}

/**
 * Parse a period string into a date range.
 * Supports: "30d" (days), "2026-03" (YYYY-MM month).
 * @param {string} period
 * @returns {{ start: Date, end: Date, label: string }}
 */
function parsePeriod(period) {
  if (!period || typeof period !== "string") {
    const now = new Date();
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      label: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    };
  }

  const dayMatch = period.match(/^(\d+)d$/);
  if (dayMatch) {
    const days = Math.min(365, Math.max(1, Number(dayMatch[1])));
    const end = new Date(Date.now() + 1000); // +1s to include records created just now
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { start, end, label: `${days}d` };
  }

  const monthMatch = period.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]) - 1;
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 1, 1),
      label: period,
    };
  }

  // Fallback: current month
  const now = new Date();
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
    label: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
  };
}

/**
 * Create a billing manager instance.
 * @returns {object}
 */
export function createBillingManager() {
  return {
    /**
     * Record token consumption for a workspace.
     * @param {string} workspaceId
     * @param {{ inputTokens?: number, outputTokens?: number, total?: number }} tokens
     * @param {string} [model]
     * @returns {Promise<{ ok: boolean, record: object }>}
     */
    async recordUsage(workspaceId, tokens, model) {
      const inputTokens = Math.max(0, Number(tokens?.inputTokens ?? tokens?.total ?? tokens) || 0);
      const outputTokens = Math.max(0, Number(tokens?.outputTokens) || 0);
      const totalTokens = inputTokens + outputTokens;
      const cost = computeCost(inputTokens, outputTokens, model);

      const record = {
        id: `bill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId: String(workspaceId || "default"),
        model: String(model || "unknown"),
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
        timestamp: new Date().toISOString(),
      };

      const records = await ensureRecords();
      records.push(record);
      await persistRecords();

      return { ok: true, record };
    },

    /**
     * Get usage summary for a workspace in a given period.
     * @param {string} workspaceId
     * @param {string} [period] - e.g., "30d" or "2026-03"
     * @returns {Promise<{ tokens: number, cost: number, breakdown: object, period: string }>}
     */
    async getUsageSummary(workspaceId, period) {
      const { start, end, label } = parsePeriod(period);
      const records = await ensureRecords();
      const ws = String(workspaceId || "default");

      const filtered = records.filter((r) => {
        if (r.workspaceId !== ws) return false;
        const ts = new Date(r.timestamp).getTime();
        return ts >= start.getTime() && ts < end.getTime();
      });

      let totalTokens = 0;
      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      const byModel = {};
      const byDay = {};

      for (const r of filtered) {
        totalTokens += r.totalTokens || 0;
        totalInput += r.inputTokens || 0;
        totalOutput += r.outputTokens || 0;
        totalCost += r.cost || 0;

        const m = r.model || "unknown";
        if (!byModel[m]) byModel[m] = { tokens: 0, cost: 0, requests: 0 };
        byModel[m].tokens += r.totalTokens || 0;
        byModel[m].cost += r.cost || 0;
        byModel[m].requests += 1;

        const day = r.timestamp ? r.timestamp.slice(0, 10) : "unknown";
        if (!byDay[day]) byDay[day] = { tokens: 0, cost: 0, requests: 0 };
        byDay[day].tokens += r.totalTokens || 0;
        byDay[day].cost += r.cost || 0;
        byDay[day].requests += 1;
      }

      totalCost = Math.round(totalCost * 10000) / 10000;

      return {
        tokens: totalTokens,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cost: totalCost,
        requests: filtered.length,
        breakdown: { byModel, byDay },
        period: label,
        workspaceId: ws,
      };
    },

    /**
     * Check plan limits for a workspace.
     * Compares current-month token usage against the plan's tokensPerMonth.
     * @param {string} workspaceId
     * @returns {Promise<{ allowed: boolean, remaining: number, plan: string, overage: number, used: number, limit: number }>}
     */
    async checkPlanLimits(workspaceId) {
      const plan = await getPlan(workspaceId);
      const now = new Date();
      const monthPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const summary = await this.getUsageSummary(workspaceId, monthPeriod);

      const limit = plan.tokensPerMonth;
      const used = summary.tokens;
      const remaining = Math.max(0, limit - used);
      const overage = Math.max(0, used - limit);
      const allowed = limit === Infinity || used < limit;

      return {
        allowed,
        remaining: limit === Infinity ? Infinity : remaining,
        plan: plan.id,
        planName: plan.name,
        overage,
        used,
        limit: limit === Infinity ? Infinity : limit,
      };
    },

    /**
     * Generate invoice data for a workspace and period.
     * @param {string} workspaceId
     * @param {string} [period] - e.g., "2026-03"
     * @returns {Promise<object>}
     */
    async getInvoice(workspaceId, period) {
      const plan = await getPlan(workspaceId);
      const summary = await this.getUsageSummary(workspaceId, period);

      const lineItems = [];

      // Plan subscription fee
      if (plan.priceMonthly > 0) {
        lineItems.push({
          description: `${plan.name} Plan — Monthly Subscription`,
          quantity: 1,
          unitPrice: plan.priceMonthly,
          total: plan.priceMonthly,
        });
      }

      // Token usage
      if (summary.tokens > 0) {
        lineItems.push({
          description: `Token Usage (${summary.requests} requests, ${summary.tokens} tokens)`,
          quantity: summary.tokens,
          unitPrice: summary.cost > 0 ? Math.round((summary.cost / summary.tokens) * 1_000_000) / 1_000_000 : 0,
          total: summary.cost,
        });
      }

      const subtotal = lineItems.reduce((s, item) => s + item.total, 0);

      return {
        invoiceId: `inv_${String(workspaceId).slice(0, 12)}_${summary.period}`,
        workspaceId: String(workspaceId),
        period: summary.period,
        plan: { id: plan.id, name: plan.name },
        lineItems,
        subtotal: Math.round(subtotal * 100) / 100,
        currency: "USD",
        generatedAt: new Date().toISOString(),
        usage: {
          tokens: summary.tokens,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          requests: summary.requests,
          cost: summary.cost,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Wave 18A — Stripe integration
// ---------------------------------------------------------------------------

const PLAN_CATALOG = {
  pro: {
    name: "SiskelBot Pro",
    priceId: process.env.STRIPE_PRO_PRICE_ID,
    requestsPerMinute: 60,
    tokensPerDay: 1_000_000,
  },
  enterprise: {
    name: "SiskelBot Enterprise",
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID,
    requestsPerMinute: 300,
    tokensPerDay: 10_000_000,
  },
};

export function getPlanCatalog() {
  return PLAN_CATALOG;
}

let _stripe = null;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" });
  }
  return _stripe;
}

function subscriptionPath(workspaceId) {
  return join(getDataDir(), "billing-subscriptions", `${workspaceId}.json`);
}

/**
 * Create a Stripe Checkout Session for upgrading a workspace to a paid plan.
 * @param {{ workspaceId: string, userId: string, planId: string, successUrl: string, cancelUrl: string, userEmail?: string }} params
 * @returns {Promise<{ url: string, sessionId: string } | { url: null, sessionId: null }>}
 */
export async function createCheckoutSession({ workspaceId, userId, planId, successUrl, cancelUrl, userEmail }) {
  const stripe = getStripe();
  if (!stripe) return { url: null, sessionId: null };

  const plan = PLAN_CATALOG[planId];
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  if (!plan.priceId) throw new Error(`No price configured for plan: ${planId}`);

  const metadata = { workspaceId, userId, planId };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: plan.priceId, quantity: 1 }],
    metadata,
    // subscription_data.metadata propagates to the Subscription object so
    // customer.subscription.updated/deleted webhooks can resolve workspaceId.
    subscription_data: { metadata },
    success_url: successUrl,
    cancel_url: cancelUrl,
    ...(userEmail ? { customer_email: userEmail } : {}),
  });

  return { url: session.url, sessionId: session.id };
}

/**
 * Create a Stripe Billing Portal session so a customer can manage their
 * subscription (update card, cancel, view invoices).
 * @param {{ workspaceId: string, returnUrl: string }} params
 * @returns {Promise<{ url: string | null }>}
 */
export async function createBillingPortalSession({ workspaceId, returnUrl }) {
  const stripe = getStripe();
  if (!stripe) return { url: null };

  const subscription = await getWorkspaceSubscription(workspaceId);
  if (!subscription.stripeCustomerId) {
    const err = new Error("No Stripe customer found for this workspace");
    err.code = "NO_SUBSCRIPTION";
    throw err;
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.stripeCustomerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

/**
 * Handle a raw Stripe webhook event after verifying the signature.
 * @param {Buffer} rawBody
 * @param {string} signature
 * @returns {Promise<{ handled: boolean, event: string }>}
 */
export async function handleWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  if (!stripe) return { handled: false, event: "stripe_disabled" };

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");

  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const { workspaceId, planId } = session.metadata || {};
      if (workspaceId && planId) {
        const current = await readJsonPath(subscriptionPath(workspaceId), {});
        await writeJsonPath(subscriptionPath(workspaceId), {
          ...current,
          plan: planId,
          status: "active",
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          updatedAt: new Date().toISOString(),
        });
      }
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const workspaceId = sub.metadata?.workspaceId;
      if (workspaceId) {
        const planId = sub.metadata?.planId;
        const status = sub.status === "active" ? "active" : sub.status === "past_due" ? "past_due" : "canceled";
        const current = await readJsonPath(subscriptionPath(workspaceId), {});
        await writeJsonPath(subscriptionPath(workspaceId), {
          ...current,
          plan: planId || current.plan || "free",
          status,
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          updatedAt: new Date().toISOString(),
        });
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const workspaceId = sub.metadata?.workspaceId;
      if (workspaceId) {
        const current = await readJsonPath(subscriptionPath(workspaceId), {});
        await writeJsonPath(subscriptionPath(workspaceId), {
          ...current,
          plan: "free",
          status: "canceled",
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          updatedAt: new Date().toISOString(),
        });
      }
      break;
    }
    default:
      return { handled: false, event: event.type };
  }

  return { handled: true, event: event.type };
}

/**
 * Get the current subscription state for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<{ plan: string, status: string, stripeCustomerId: string|null, stripeSubscriptionId: string|null, updatedAt: string|null }>}
 */
export async function getWorkspaceSubscription(workspaceId) {
  const data = await readJsonPath(subscriptionPath(workspaceId), {});
  return {
    plan: data.plan || "free",
    status: data.status || "active",
    stripeCustomerId: data.stripeCustomerId || null,
    stripeSubscriptionId: data.stripeSubscriptionId || null,
    updatedAt: data.updatedAt || null,
  };
}
