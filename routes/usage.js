import express from "express";
import rateLimit from "express-rate-limit";

export default function mountUsageRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    isAuthConfigured,
    isQuotaConfigured,
    getWorkspaceQuota,
    getSummary,
    getDashboard,
    exportToCsv,
    exportToJson,
    getRecordsForPeriod,
  } = deps;

  const usageSummaryRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  apiRoute("get", "/usage/summary", usageSummaryRateLimiter, logRequest, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query?.days) || 7));
      const workspace = req.query?.workspace ? String(req.query.workspace).trim() : "default";
      const summary = await getSummary(days);
      const userId = req.userId || null;

      if (isQuotaConfigured()) {
        const quota = await getWorkspaceQuota(workspace, userId);
        if (quota) {
          res.setHeader("X-Quota-Limit", String(quota.limit));
          res.setHeader("X-Quota-Remaining", String(quota.remaining));
          res.setHeader("X-Quota-Reset", String(quota.resetAt));
          summary.quota = { limit: quota.limit, used: quota.used, remaining: quota.remaining, resetAt: quota.resetAt };
        }
      }
      res.json(summary);
    } catch (err) {
      console.error("Usage summary error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Analytics
  const analyticsRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const analyticsHandlers = [analyticsRateLimiter, logRequest];
  if (isAuthConfigured()) analyticsHandlers.push(userAuth);

  apiRoute("get", "/analytics/dashboard", ...analyticsHandlers, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query?.days) || 7));
      const workspace = req.query?.workspace ? String(req.query.workspace).trim() : undefined;
      const opts = { workspace };
      if (req.userId) opts.userId = req.userId;
      const dashboard = await getDashboard(days, opts);
      if (isQuotaConfigured() && (workspace || "default")) {
        const quota = await getWorkspaceQuota(workspace || "default", req.userId || null);
        if (quota) {
          res.setHeader("X-Quota-Limit", String(quota.limit));
          res.setHeader("X-Quota-Remaining", String(quota.remaining));
          res.setHeader("X-Quota-Reset", String(quota.resetAt));
          dashboard.quota = { limit: quota.limit, used: quota.used, remaining: quota.remaining, resetAt: quota.resetAt };
        }
      }
      res.json(dashboard);
    } catch (err) {
      console.error("Analytics dashboard error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/analytics/export", ...analyticsHandlers, async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query?.days) || 30));
      const format = (req.query?.format || "json").toLowerCase();
      const workspace = req.query?.workspace ? String(req.query.workspace).trim() : undefined;
      const opts = { workspace };
      if (req.userId) opts.userId = req.userId;
      const records = await getRecordsForPeriod(days, opts);
      const dashboard = await getDashboard(days, opts);

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="analytics-${days}d.csv"`);
        return res.send(exportToCsv(records));
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="analytics-${days}d.json"`);
      res.send(exportToJson({ days, records, summary: dashboard }));
    } catch (err) {
      console.error("Analytics export error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
