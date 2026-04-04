import express from "express";
import rateLimit from "express-rate-limit";
import { isEmailConfigured, sendEmail, sendDigest, getDigestRecipients, isDigestEnabled } from "../lib/email-notifications.js";
import { isJiraConfigured, createJiraIssue, searchJiraIssues } from "../lib/jira-integration.js";
import { isLinearConfigured, createLinearIssue, searchLinearIssues } from "../lib/linear-integration.js";

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
    adminAuth,
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

  // GET /api/integrations/status
  apiRoute("get", "/integrations/status", (req, res) => {
    res.json({
      github: Boolean(GITHUB_TOKEN),
      vercel: Boolean(VERCEL_TOKEN),
      email: isEmailConfigured(),
      jira: isJiraConfigured(),
      linear: isLinearConfigured(),
      slack: Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_WEBHOOK_URL),
      discord: Boolean(process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_WEBHOOK_URL),
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

  // ─── Email integration routes ────────────────────────────────────────────

  // POST /api/integrations/email/test - send a test email
  apiRoute("post", "/integrations/email/test",
    integrationRateLimiter,
    adminAuth,
    async (req, res) => {
      if (!isEmailConfigured()) {
        return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "Email not configured", "Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS environment variables.");
      }
      const { to } = req.body || {};
      if (!to || typeof to !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "Recipient email (to) is required");
      }
      try {
        const result = await sendEmail(to, "SiskelBot Test Email", "<h1>Test</h1><p>This is a test email from SiskelBot.</p>", { html: true });
        res.json({ ok: true, ...result });
      } catch (err) {
        return apiError(res, 502, "EMAIL_SEND_FAILED", err.message, "Check SMTP configuration.");
      }
    }
  );

  // POST /api/integrations/email/digest - trigger manual digest
  apiRoute("post", "/integrations/email/digest",
    integrationRateLimiter,
    adminAuth,
    async (req, res) => {
      if (!isEmailConfigured()) {
        return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "Email not configured", "Set SMTP_HOST environment variables.");
      }
      const recipients = (req.body && req.body.recipients) || getDigestRecipients();
      if (!recipients || recipients.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "No recipients specified", "Pass recipients in body or set EMAIL_DIGEST_RECIPIENTS.");
      }
      const events = (req.body && req.body.events) || [];
      const period = (req.body && req.body.period) || "daily";
      try {
        const results = await sendDigest(recipients, events, period);
        res.json({ ok: true, results });
      } catch (err) {
        return apiError(res, 502, "EMAIL_SEND_FAILED", err.message, "Check SMTP configuration.");
      }
    }
  );

  // ─── Jira integration routes ─────────────────────────────────────────────

  function requireJiraConfigured(req, res, next) {
    if (!isJiraConfigured()) {
      return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "Jira integration unavailable", "Set JIRA_URL, JIRA_EMAIL, and JIRA_API_TOKEN environment variables.");
    }
    next();
  }

  // GET /api/integrations/jira/search?jql=...
  apiRoute("get", "/integrations/jira/search",
    integrationRateLimiter,
    requireJiraConfigured,
    async (req, res) => {
      const jql = req.query.jql;
      if (!jql || typeof jql !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "JQL query parameter is required");
      }
      try {
        const data = await searchJiraIssues(jql);
        res.json(data);
      } catch (err) {
        return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check Jira configuration and connectivity.");
      }
    }
  );

  // POST /api/integrations/jira/issues
  apiRoute("post", "/integrations/jira/issues",
    integrationRateLimiter,
    requireJiraConfigured,
    async (req, res) => {
      const { projectKey, summary, description, issueType, priority, labels, assignee } = req.body || {};
      if (!summary || typeof summary !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "Summary is required");
      }
      try {
        const data = await createJiraIssue(projectKey, summary, description || "", { issueType, priority, labels, assignee });
        res.status(201).json(data);
      } catch (err) {
        const status = err.status || 502;
        return apiError(res, status, "JIRA_ERROR", err.message, "Check Jira configuration.");
      }
    }
  );

  // ─── Linear integration routes ───────────────────────────────────────────

  function requireLinearConfigured(req, res, next) {
    if (!isLinearConfigured()) {
      return apiError(res, 503, "INTEGRATION_UNAVAILABLE", "Linear integration unavailable", "Set LINEAR_API_KEY environment variable.");
    }
    next();
  }

  // GET /api/integrations/linear/issues?q=...
  apiRoute("get", "/integrations/linear/issues",
    integrationRateLimiter,
    requireLinearConfigured,
    async (req, res) => {
      const q = req.query.q;
      if (!q || typeof q !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "Query parameter (q) is required");
      }
      try {
        const data = await searchLinearIssues(q);
        res.json(data);
      } catch (err) {
        return apiError(res, 502, "BACKEND_UNREACHABLE", err.message, "Check Linear configuration and connectivity.");
      }
    }
  );

  // POST /api/integrations/linear/issues
  apiRoute("post", "/integrations/linear/issues",
    integrationRateLimiter,
    requireLinearConfigured,
    async (req, res) => {
      const { teamId, title, description, priority, labels, assigneeId, stateId } = req.body || {};
      if (!title || typeof title !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "Title is required");
      }
      try {
        const data = await createLinearIssue(teamId, title, description || "", { priority, labels, assigneeId, stateId });
        res.status(201).json(data);
      } catch (err) {
        const status = err.status || 502;
        return apiError(res, status, "LINEAR_ERROR", err.message, "Check Linear configuration.");
      }
    }
  );
}
