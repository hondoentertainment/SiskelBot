/**
 * Phase 24: Monetization & Multi-Tenancy — Billing routes.
 *
 * GET  /api/v1/billing/usage?workspace=X&period=30d   — usage summary
 * GET  /api/v1/billing/invoice?workspace=X&period=2026-03 — invoice data
 * GET  /api/v1/billing/plans                          — list available plans (public)
 * GET  /api/v1/billing/plan?workspace=X               — current plan
 * PUT  /api/v1/billing/plan                           — change plan
 *
 * Wave 18A — Stripe integration:
 * GET  /api/v1/billing/subscription  — current workspace Stripe subscription (auth required)
 * POST /api/v1/billing/checkout      — create Stripe Checkout Session (auth required)
 * POST /api/v1/billing/webhook       — Stripe webhook (raw body, signature verified)
 */
import { createBillingManager, createCheckoutSession, createPortalSession, handleWebhookEvent, getWorkspaceSubscription, getPlanCatalog } from "../lib/billing.js";
import { listPlans, getPlan, setPlan } from "../lib/plans.js";
import express from "express";

export function mountBillingRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    sanitizeWorkspace,
    storageRateLimiter,
    userAuth,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());
  const billing = createBillingManager();

  // GET /api/v1/billing/usage?workspace=X&period=30d
  apiRoute("get", "/billing/usage", limiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const period = req.query?.period || "30d";
      const summary = await billing.getUsageSummary(workspace, period);
      res.json(summary);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/billing/invoice?workspace=X&period=2026-03
  apiRoute("get", "/billing/invoice", limiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const period = req.query?.period || undefined;
      const invoice = await billing.getInvoice(workspace, period);
      res.json(invoice);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/billing/plans — list available plans (public, no auth)
  apiRoute("get", "/billing/plans", logRequest, (req, res) => {
    try {
      const plans = listPlans();
      const stripePlans = getPlanCatalog();
      res.json({ plans, stripePlans });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/billing/plan?workspace=X — current plan
  apiRoute("get", "/billing/plan", limiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const plan = await getPlan(workspace);
      res.json({ workspaceId: workspace, plan });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/billing/plan — change plan
  apiRoute("put", "/billing/plan", limiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const planId = req.body?.planId;

      if (!planId || typeof planId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "planId is required");
      }

      const result = await setPlan(workspace, planId);
      if (!result.ok) {
        return apiError(res, 400, "INVALID_PLAN", result.error);
      }

      res.json({ workspaceId: workspace, plan: result.plan });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // Wave 18A — Stripe routes

  // GET /api/v1/billing/subscription — current workspace Stripe subscription
  apiRoute("get", "/billing/subscription", userAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace || req.body?.workspaceId || "default");
      const subscription = await getWorkspaceSubscription(workspaceId);
      res.json({ workspaceId, subscription });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/billing/checkout — create Stripe Checkout Session
  apiRoute("post", "/billing/checkout", userAuth, logRequest, async (req, res) => {
    try {
      const { planId, workspaceId: bodyWs } = req.body || {};
      const baseUrl = process.env.APP_BASE_URL || "";
      const successUrl = req.body?.successUrl || `${baseUrl}/billing/success`;
      const cancelUrl = req.body?.cancelUrl || `${baseUrl}/billing/cancel`;
      const workspaceId = sanitizeWorkspace(bodyWs || "default");
      const userId = req.userId || "anonymous";
      const userEmail = req.user?.email || req.userEmail || undefined;

      if (!planId || typeof planId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "planId is required");
      }
      if (!successUrl || typeof successUrl !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "successUrl is required (or set APP_BASE_URL)");
      }
      if (!cancelUrl || typeof cancelUrl !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "cancelUrl is required (or set APP_BASE_URL)");
      }

      if (!process.env.STRIPE_SECRET_KEY) {
        return apiError(res, 503, "STRIPE_DISABLED", "Stripe is not configured on this server");
      }

      const result = await createCheckoutSession({ workspaceId, userId, planId, successUrl, cancelUrl, userEmail });
      res.json(result);
    } catch (err) {
      const msg = err.message || "Checkout session creation failed";
      const status = msg.includes("Unknown plan") || msg.includes("No price") ? 400 : 500;
      return apiError(res, status, "CHECKOUT_ERROR", msg);
    }
  });

  // POST /api/v1/billing/portal — create Stripe Billing Portal session so the
  // customer can manage payment method, cancel, view invoices.
  apiRoute("post", "/billing/portal", userAuth, logRequest, async (req, res) => {
    try {
      if (!process.env.STRIPE_SECRET_KEY) {
        return apiError(res, 503, "STRIPE_DISABLED", "Stripe is not configured on this server");
      }
      const workspaceId = sanitizeWorkspace(req.body?.workspaceId || "default");
      const baseUrl = process.env.APP_BASE_URL || "";
      const returnUrl = req.body?.returnUrl || `${baseUrl}/billing`;
      if (!returnUrl) {
        return apiError(res, 400, "INVALID_INPUT", "returnUrl is required (or set APP_BASE_URL)");
      }
      const subscription = await getWorkspaceSubscription(workspaceId);
      if (!subscription.stripeCustomerId) {
        return apiError(res, 404, "NO_SUBSCRIPTION", "No Stripe customer found for this workspace");
      }
      const result = await createPortalSession({
        stripeCustomerId: subscription.stripeCustomerId,
        returnUrl,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "PORTAL_ERROR", err.message || "Portal session creation failed");
    }
  });

  // POST /api/v1/billing/webhook — Stripe webhook (raw body required for sig verification)
  // This route is registered directly on app (not via apiRoute/dualRegister) so we can
  // use express.raw() middleware before the handler without affecting other routes.
  app.post(
    "/api/v1/billing/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const signature = req.headers["stripe-signature"];
      if (!signature) {
        return res.status(400).json({ error: "Missing stripe-signature header" });
      }
      try {
        const result = await handleWebhookEvent(req.body, signature);
        res.json({ received: true, ...result });
      } catch (err) {
        const msg = err.message || "Webhook processing failed";
        const status = msg.includes("signature") || msg.includes("No signatures") || msg.includes("timestamp") ? 400 : 500;
        res.status(status).json({ error: msg });
      }
    }
  );
}
