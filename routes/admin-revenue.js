/**
 * Admin revenue dashboard — operator business metrics.
 * GET /api/v1/admin/revenue            — MRR, ARR, plan mix, churn (admin)
 * GET /api/v1/admin/revenue/customers  — customer list with plan/status/usage (admin)
 */
import { getRevenueSummary, listCustomers } from "../lib/revenue-analytics.js";

export function mountAdminRevenueRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter, adminAuth } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());
  const admin = adminAuth || ((req, res, next) => next());

  apiRoute("get", "/admin/revenue", limiter, admin, async (req, res) => {
    try {
      const summary = await getRevenueSummary();
      res.json({ ok: true, ...summary });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/admin/revenue/customers", limiter, admin, async (req, res) => {
    try {
      const includeUsage = req.query?.usage !== "0";
      const customers = await listCustomers({ includeUsage });
      res.json({ ok: true, customers, count: customers.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
