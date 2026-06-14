import rateLimit from "express-rate-limit";
import {
  getUsageSummary,
  generateUsageCsv,
  checkUsageThresholds,
  listUsageAlerts,
} from "../lib/usage-reports.js";

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
    adminAuth,
    storage,
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

  const usageV1RateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const authGuard = isAuthConfigured ? (isAuthConfigured() ? [userAuth] : []) : [];

  // GET /api/v1/usage/summary — workspace usage summary
  apiRoute("get", "/usage/summary", usageV1RateLimiter, ...authGuard, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspace ? String(req.query.workspace).trim() : "default";
      const from = req.query?.from ? String(req.query.from) : undefined;
      const to = req.query?.to ? String(req.query.to) : undefined;
      const summary = await getUsageSummary(workspaceId, { from, to });
      res.json(summary);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/usage/export — download usage CSV
  apiRoute("get", "/usage/export", usageV1RateLimiter, ...authGuard, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspace ? String(req.query.workspace).trim() : "default";
      const from = req.query?.from ? String(req.query.from) : undefined;
      const to = req.query?.to ? String(req.query.to) : undefined;

      const now = new Date();
      const monthLabel = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const filename = `usage-${monthLabel}.csv`;

      const csv = await generateUsageCsv(workspaceId, { from, to });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/usage/alerts — list recent threshold alerts for workspace
  apiRoute("get", "/usage/alerts", usageV1RateLimiter, ...authGuard, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspace ? String(req.query.workspace).trim() : "default";
      const alerts = await listUsageAlerts(workspaceId, storage);
      res.json({ workspaceId, alerts });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/admin/usage/check-thresholds — trigger threshold check for all workspaces (admin)
  // No scheduler is wired for this; call this endpoint to run on demand.
  apiRoute("post", "/admin/usage/check-thresholds", adminAuth, logRequest, async (req, res) => {
    try {
      const workspaceIds = req.body?.workspaceIds;
      const targets = Array.isArray(workspaceIds) && workspaceIds.length > 0
        ? workspaceIds.map(String)
        : ["default"];

      const results = [];
      for (const ws of targets) {
        const result = await checkUsageThresholds(ws, storage);
        results.push({ workspaceId: ws, ...result });
      }
      res.json({ results });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
