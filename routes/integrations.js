import rateLimit from "express-rate-limit";

export function mountIntegrationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    logRequest,
    integrationRateLimiter,
    isAuthConfigured,
    isQuotaConfigured,
    getWorkspaceQuota,
    getSummary,
    getRecordsForPeriod,
    getDashboard,
    exportToCsv,
    exportToJson,
    runMonitoringChecks,
    monitoringState: getMonitoringState,
    isMonitoringEnabled,
    runHealthChecks,
    GITHUB_TOKEN,
    VERCEL_TOKEN,
    validateOwnerRepo,
    requireGitHubToken,
    requireVercelToken,
    GITHUB_API_BASE,
    VERCEL_API_BASE,
  } = deps;

  const usageSummaryRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const analyticsRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const analyticsHandlers = [analyticsRateLimiter, logRequest];
  if (isAuthConfigured()) analyticsHandlers.push(userAuth);

  const monitoringRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many monitoring requests", "Wait before refreshing again.");
    },
  });

  apiRoute("get", "/integrations/status", (req, res) => {
    res.json({
      github: Boolean(GITHUB_TOKEN),
      vercel: Boolean(VERCEL_TOKEN),
    });
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

  apiRoute("get", "/monitoring/status", monitoringRateLimiter, async (req, res) => {
    if (!isMonitoringEnabled()) {
      return apiError(res, 503, "MONITORING_DISABLED", "Monitoring is disabled", "Set ENABLE_MONITORING=1 and GITHUB_TOKEN or VERCEL_TOKEN.");
    }
    const forceRefresh = req.query?.refresh === "1";
    if (forceRefresh) {
      try {
        const data = await runMonitoringChecks();
        return res.json(data);
      } catch (err) {
        return apiError(res, 503, "CHECK_FAILED", err.message, "Monitoring check failed. See docs/RUNBOOK.md.");
      }
    }
    const state = getMonitoringState();
    if (state.lastCheck) {
      return res.json(state);
    }
    try {
      const data = await runMonitoringChecks();
      return res.json(data);
    } catch (err) {
      return apiError(res, 503, "CHECK_FAILED", err.message, "Monitoring check failed. See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/status/report", async (req, res) => {
    try {
      const [health, integrations] = await Promise.all([
        runHealthChecks(),
        Promise.resolve({
          github: Boolean(GITHUB_TOKEN),
          vercel: Boolean(VERCEL_TOKEN),
        }),
      ]);
      res.json({
        timestamp: new Date().toISOString(),
        health,
        integrations,
      });
    } catch (err) {
      return apiError(
        res,
        503,
        "REPORT_FAILED",
        err.message,
        "Health or integration checks failed. See docs/RUNBOOK.md."
      );
    }
  });

  const ghBase = GITHUB_API_BASE.replace(/\/$/, "");
  const vercelBase = VERCEL_API_BASE.replace(/\/$/, "");

  apiRoute("get", "/github/repos", integrationRateLimiter, requireGitHubToken, async (req, res) => {
    try {
      const r = await fetch(`${ghBase}/user/repos?per_page=50`, {
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `Bearer ${GITHUB_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "GitHub API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check GITHUB_TOKEN and network connectivity to api.github.com.");
    }
  });

  apiRoute(
    "get",
    "/github/repo/:owner/:repo",
    integrationRateLimiter,
    requireGitHubToken,
    (req, res, next) => {
      const { owner, repo } = req.params;
      if (!validateOwnerRepo(owner, repo)) {
        return apiError(res, 400, "INVALID_INPUT", "Invalid owner or repo", "Use alphanumeric owner/repo names (e.g. octocat/hello-world).");
      }
      next();
    },
    async (req, res) => {
      const { owner, repo } = req.params;
      try {
        const r = await fetch(`${ghBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${GITHUB_TOKEN}`,
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
          const text = await r.text();
          return res.status(r.status).json({
            error: "GitHub API error",
            code: "BACKEND_ERROR",
            hint: (text || `HTTP ${r.status}`).slice(0, 500),
          });
        }
        const data = await r.json();
        res.json(data);
      } catch (err) {
        return apiError(res, 502, "BACKEND_UNREACHABLE", "GitHub proxy error: " + err.message, "Check GITHUB_TOKEN and network connectivity.");
      }
    }
  );

  apiRoute(
    "get",
    "/github/issues/:owner/:repo",
    integrationRateLimiter,
    requireGitHubToken,
    (req, res, next) => {
      const { owner, repo } = req.params;
      if (!validateOwnerRepo(owner, repo)) {
        return apiError(res, 400, "INVALID_INPUT", "Invalid owner or repo", "Use alphanumeric owner/repo names (e.g. octocat/hello-world).");
      }
      next();
    },
    async (req, res) => {
      const { owner, repo } = req.params;
      const qs = new URLSearchParams(req.query).toString();
      const suffix = qs ? `?${qs}` : "";
      try {
        const r = await fetch(`${ghBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${suffix}`, {
          headers: {
            Accept: "application/vnd.github.v3+json",
            Authorization: `Bearer ${GITHUB_TOKEN}`,
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
          const text = await r.text();
          return res.status(r.status).json({
            error: "GitHub API error",
            code: "BACKEND_ERROR",
            hint: (text || `HTTP ${r.status}`).slice(0, 500),
          });
        }
        const data = await r.json();
        res.json(data);
      } catch (err) {
        return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check GITHUB_TOKEN and network connectivity to api.github.com.");
      }
    }
  );

  apiRoute("get", "/vercel/deployments", integrationRateLimiter, requireVercelToken, async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const url = `${vercelBase}/v6/deployments${qs ? `?${qs}` : ""}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "Vercel API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check VERCEL_TOKEN and network connectivity to api.vercel.com.");
    }
  });

  apiRoute("get", "/vercel/projects", integrationRateLimiter, requireVercelToken, async (req, res) => {
    try {
      const qs = new URLSearchParams(req.query).toString();
      const url = `${vercelBase}/v10/projects${qs ? `?${qs}` : ""}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${VERCEL_TOKEN}`,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) {
        const text = await r.text();
        return res.status(r.status).json({
          error: "Vercel API error",
          code: "BACKEND_ERROR",
          hint: (text || `HTTP ${r.status}`).slice(0, 500),
        });
      }
      const data = await r.json();
      res.json(data);
    } catch (err) {
      return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check VERCEL_TOKEN and network connectivity to api.vercel.com.");
    }
  });
}
