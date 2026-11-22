/**
 * GET /api/v1/usage/dashboard?days=30
 */
import { usageDashboard, userBudgetStatus } from "../lib/usage-dashboard.js";

export function mountUsageDashboardRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, logRequest } = deps;
  const auth = userAuth || ((_req, _res, next) => next());
  const log = logRequest || ((_req, _res, next) => next());

  apiRoute("get", "/usage/dashboard", log, auth, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query?.days) || 30));
      const report = await usageDashboard(days);
      const mine = await userBudgetStatus(req.userId || "anonymous");
      res.json({ ...report, you: mine });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
