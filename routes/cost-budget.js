/**
 * Per-workspace cost budgets.
 * GET /api/v1/cost-budget          — current spend + cap for a workspace
 * PUT /api/v1/cost-budget          — set/clear the workspace cap (admin)
 */
import { getBudgetStatus, setBudget } from "../lib/cost-budget.js";

export function mountCostBudgetRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter, adminAuth } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());
  const admin = adminAuth || ((req, res, next) => next());

  function workspaceOf(req) {
    return req.headers["x-workspace-id"] || req.query?.workspace || req.body?.workspaceId || "default";
  }

  apiRoute("get", "/cost-budget", limiter, async (req, res) => {
    try {
      const status = await getBudgetStatus(workspaceOf(req));
      res.json({ ok: true, budget: status });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/cost-budget", limiter, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!("budgetUsd" in body)) {
        return apiError(res, 400, "INVALID_INPUT", "budgetUsd is required (number, or null to clear)");
      }
      const status = await setBudget(workspaceOf(req), body.budgetUsd === null ? null : body.budgetUsd);
      res.json({ ok: true, budget: status });
    } catch (err) {
      if (err.message.includes("non-negative")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
