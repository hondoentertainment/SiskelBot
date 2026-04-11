/**
 * Phase 24: Monetization & Multi-Tenancy — Billing routes.
 *
 * GET  /api/v1/billing/usage?workspace=X&period=30d   — usage summary
 * GET  /api/v1/billing/invoice?workspace=X&period=2026-03 — invoice data
 * GET  /api/v1/billing/plans                          — list available plans
 * GET  /api/v1/billing/plan?workspace=X               — current plan
 * PUT  /api/v1/billing/plan                           — change plan
 */
import { createBillingManager } from "../lib/billing.js";
import { listPlans, getPlan, setPlan } from "../lib/plans.js";

export function mountBillingRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    sanitizeWorkspace,
    storageRateLimiter,
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

  // GET /api/v1/billing/plans — list available plans
  apiRoute("get", "/billing/plans", logRequest, (req, res) => {
    try {
      const plans = listPlans();
      res.json({ plans });
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
}
