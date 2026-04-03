import express from "express";
import rateLimit from "express-rate-limit";

export default function mountIntegrationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    integrationRateLimiter,
    logRequest,
    isMonitoringEnabled,
    GITHUB_TOKEN,
    VERCEL_TOKEN,
    GITHUB_API_BASE,
    VERCEL_API_BASE,
    MONITORING_REPO,
    MONITORING_INTERVAL_MS,
    runHealthChecks,
  } = deps;

  const STALE_PR_DAYS = 7;
  const OWNER_REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

  function validateOwnerRepo(owner, repo) {
    return (
      typeof owner === "string" &&
      typeof repo === "string" &&
      OWNER_REPO_PATTERN.test(owner) &&
      OWNER_REPO_PATTERN.test(repo) &&
      owner.length <= 100 &&
      repo.length <= 100
    );
  }
// Integrations, usage, analytics, monitoring, status, GitHub, and Vercel routes extracted from server.js
import rateLimit from "express-rate-limit";

export function mountIntegrationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    logRequest,
    integrationRateLimiter,
    sanitizeWorkspace,
    isAuthConfigured,
    isQuotaConfigured,
    getWorkspaceQuota,
    getSummary,
    getRecordsForPeriod,
    getDashboard,
    exportToCsv,
    exportToJson,
    runMonitoringChecks,
    monitoringState,
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

  // Usage summary
  const usageSummaryRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
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

  // Monitoring
  const monitoringRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many monitoring requests", "Wait before refreshing again.");
    },
  });

  // GET /api/integrations/status
  apiRoute("get", "/integrations/status", (req, res) => {
    res.json({
      github: Boolean(GITHUB_TOKEN),
      vercel: Boolean(VERCEL_TOKEN),
    });
  });

  // --- Monitoring ---
  let monitoringState = {
    lastCheck: null,
    checks: { github: null, vercel: null },
    summary: "idle",
    alerts: [],
  };
  let monitoringIntervalId = null;

  async function runMonitoringChecks() {
    const alerts = [];
    const checks = { github: null, vercel: null };

    if (GITHUB_TOKEN && MONITORING_REPO) {
      const [owner, repo] = MONITORING_REPO.split("/").map((s) => s.trim());
      if (owner && repo && validateOwnerRepo(owner, repo)) {
        try {
          const base = GITHUB_API_BASE.replace(/\/$/, "");
          const [commitsRes, prsRes] = await Promise.all([
            fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=1`, {
              headers: { Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${GITHUB_TOKEN}` },
              signal: AbortSignal.timeout(10000),
            }),
            fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=30`, {
              headers: { Accept: "application/vnd.github.v3+json", Authorization: `Bearer ${GITHUB_TOKEN}` },
              signal: AbortSignal.timeout(10000),
            }),
          ]);
          const lastCommit = commitsRes.ok ? (await commitsRes.json())[0] : null;
          const openPRs = prsRes.ok ? await prsRes.json() : [];
          const now = Date.now();
          const stalePRs = openPRs.filter((pr) => {
            const created = pr.created_at ? new Date(pr.created_at).getTime() : 0;
            return (now - created) / (24 * 60 * 60 * 1000) > STALE_PR_DAYS;
          });
          checks.github = {
            ok: commitsRes.ok && prsRes.ok,
            lastCommit: lastCommit ? { sha: lastCommit.sha?.slice(0, 7), date: lastCommit.commit?.author?.date, message: lastCommit.commit?.message?.split("\n")[0] } : null,
            openPRs: openPRs.length,
            stalePRs: stalePRs.length,
          };
          if (stalePRs.length > 0) alerts.push({ type: "stale_prs", count: stalePRs.length, message: `${stalePRs.length} PR(s) open > ${STALE_PR_DAYS} days` });
          if (!commitsRes.ok || !prsRes.ok) {
            checks.github.ok = false;
            checks.github.error = commitsRes.ok ? (await prsRes.text()).slice(0, 200) : (await commitsRes.text()).slice(0, 200);
            alerts.push({ type: "github_error", message: "GitHub API error" });
          }
        } catch (err) {
          checks.github = { ok: false, error: err.message };
          alerts.push({ type: "github_error", message: err.message });
        }
      } else {
        checks.github = { ok: false, error: "Invalid MONITORING_REPO format (use owner/repo)" };
      }
    } else if (GITHUB_TOKEN) {
      checks.github = { ok: true, configured: false, reason: "MONITORING_REPO not set" };
    }

    if (VERCEL_TOKEN) {
      try {
        const base = VERCEL_API_BASE.replace(/\/$/, "");
        const r = await fetch(`${base}/v6/deployments?limit=1`, {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
          signal: AbortSignal.timeout(10000),
        });
        const data = r.ok ? await r.json() : null;
        const deployments = data?.deployments || (Array.isArray(data) ? data : []);
        const last = deployments[0];
        const state = last?.state || null;
        const failed = state === "ERROR" || state === "CANCELED";
        checks.vercel = {
          ok: r.ok,
          lastDeploy: last ? { state, url: last.url, created: last.created } : null,
          failed,
        };
        if (failed) alerts.push({ type: "deploy_failed", message: `Last deployment: ${state}` });
        if (!r.ok) {
          checks.vercel.error = (await r.text()).slice(0, 200);
          alerts.push({ type: "vercel_error", message: "Vercel API error" });
        }
      } catch (err) {
        checks.vercel = { ok: false, error: err.message };
        alerts.push({ type: "vercel_error", message: err.message });
      }
    }

    const summary = alerts.length > 0 ? "alerts" : "ok";
    monitoringState = {
      lastCheck: new Date().toISOString(),
      checks,
      summary,
      alerts,
    };
    return monitoringState;
  }

  const monitoringRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      apiError(res, 429, "RATE_LIMITED", "Too many monitoring requests", "Wait before refreshing again.");
    },
  });

  // GET /api/usage/summary
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

  // GET /api/analytics/dashboard
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

  // GET /api/analytics/export
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

  // GET /api/monitoring/status
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
    if (monitoringState.lastCheck) {
      return res.json(monitoringState);
    const state = monitoringState();
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

  if (isMonitoringEnabled()) {
    runMonitoringChecks().catch((e) => console.warn("[monitoring] Initial check failed:", e.message));
    monitoringIntervalId = setInterval(() => {
      runMonitoringChecks().catch((e) => console.warn("[monitoring] Scheduled check failed:", e.message));
    }, MONITORING_INTERVAL_MS);
  }

  // Status report
  // GET /api/status/report
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

  // GitHub proxy
  function requireGitHubToken(req, res, next) {
    if (!GITHUB_TOKEN) {
      return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "GitHub integration unavailable", "Set GITHUB_TOKEN in server environment variables.");
    }
    next();
  }

  // --- GitHub proxy ---
  apiRoute("get", "/github/repos",
    integrationRateLimiter,
    requireGitHubToken,
    async (req, res) => {
      try {
        const r = await fetch("https://api.github.com/user/repos?per_page=50", {
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

  apiRoute("get", "/github/repo/:owner/:repo",
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
        const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
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

  apiRoute("get", "/github/issues/:owner/:repo",
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
        const r = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues${suffix}`,
          {
            headers: {
              Accept: "application/vnd.github.v3+json",
              Authorization: `Bearer ${GITHUB_TOKEN}`,
            },
            signal: AbortSignal.timeout(10000),
          }
        );
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

  // Vercel proxy
  function requireVercelToken(req, res, next) {
    if (!VERCEL_TOKEN) {
      return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "Vercel integration unavailable", "Set VERCEL_TOKEN in server environment variables.");
    }
    next();
  }

  // --- Vercel proxy ---
  apiRoute("get", "/vercel/deployments",
    integrationRateLimiter,
    requireVercelToken,
    async (req, res) => {
      try {
        const qs = new URLSearchParams(req.query).toString();
        const url = `https://api.vercel.com/v6/deployments${qs ? `?${qs}` : ""}`;
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
    }
  );

  apiRoute("get", "/vercel/projects",
    integrationRateLimiter,
    requireVercelToken,
    async (req, res) => {
      try {
        const qs = new URLSearchParams(req.query).toString();
        const url = `https://api.vercel.com/v10/projects${qs ? `?${qs}` : ""}`;
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
    }
  );
}
