import express from "express";
import rateLimit from "express-rate-limit";

export default function mountAdminRoutes(app, deps) {
  const {
    apiError,
    logRequest,
    adminAuth,
    requireScope,
    sanitizeWorkspace,
    runHealthChecks,
    // admin-data
// Admin dashboard, API keys, audit, routing, regions, observability routes extracted from server.js
import rateLimit from "express-rate-limit";
import express from "express";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

export function mountAdminRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    adminAuth,
    requireScope,
    logRequest,
    sanitizeWorkspace,
    // Admin data
    listAllUsers,
    listAllWorkspaces,
    getRecentAuditLog,
    getSummary,
    // quotas
    isQuotaConfigured,
    getWorkspaceQuota,
    getWorkspaceTokensUsed,
    setWorkspaceQuotaOverride,
    getQuotaOverrides,
    // api-keys
    listKeysForAdmin,
    addKey,
    revokeKey,
    // audit
    // Quota
    isQuotaConfigured,
    getWorkspaceQuota,
    getWorkspaceTokensUsed,
    getQuotaOverrides,
    setWorkspaceQuotaOverride,
    // API keys
    listKeysForAdmin,
    addKey,
    revokeKey,
    // Audit
    archiveExecutionAuditToS3,
    getAuditArchiveStatus,
    AuditLifecycle,
    queryAudit,
    exportAudit,
    // routing
    getRoutingStats,
    AB_ROUTING_ENABLED,
    MODEL_ROUTING_CONFIG,
    // regions
    getRegionHealth,
    getLeaderElection,
    // replication
    getReplicationManager,
    internalAuth,
    // Routing
    getRoutingStats,
    AB_ROUTING_ENABLED,
    MODEL_ROUTING_CONFIG,
    // Regions
    getRegionHealth,
    getLeaderElection,
    getReplicationManager,
    internalAuth,
    // Observability
    getMetricsSummary,
    obsGetLatencyPercentiles,
    obsGetErrorRates,
    obsGetAgentStats,
    obsGetTokenUsageByWorkspace,
    // Health
    runHealthChecks,
  } = deps;

  const adminRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  function adminAuthOrQuery(req, res, next) {
    const adminKey = process.env.ADMIN_API_KEY;
    if (adminKey && req.method === "GET" && req.query?.key === adminKey) {
      return next();
    }
    return adminAuth(req, res, next);
  }

  // Admin page
  app.get("/admin", (req, res) => {
    res.sendFile(join(rootDir, "client", "admin.html"));
  });

  // Marketplace page
  app.get("/marketplace", (req, res) => {
    res.sendFile(join(rootDir, "client", "marketplace.html"));
  });

  // Observability page
  app.get("/observability", (req, res) => {
    res.sendFile(join(rootDir, "client", "observability.html"));
  });

  // Observability API
  apiRoute("get", "/observability/summary", adminAuth, requireScope("admin"), (req, res) => {
    const windowMinutes = Math.min(Number(req.query.window) || 60, 60);
    res.json(getMetricsSummary(windowMinutes));
  });

  apiRoute("get", "/observability/latency", adminAuth, requireScope("admin"), (req, res) => {
    const windowMinutes = Math.min(Number(req.query.window) || 60, 60);
    res.json(obsGetLatencyPercentiles(windowMinutes));
  });

  apiRoute("get", "/observability/errors", adminAuth, requireScope("admin"), (req, res) => {
    const windowMinutes = Math.min(Number(req.query.window) || 60, 60);
    res.json(obsGetErrorRates(windowMinutes));
  });

  apiRoute("get", "/observability/agents", adminAuth, requireScope("admin"), (req, res) => {
    const windowMinutes = Math.min(Number(req.query.window) || 60, 60);
    res.json(obsGetAgentStats(windowMinutes));
  });

  apiRoute("get", "/observability/tokens", adminAuth, requireScope("admin"), (req, res) => {
    const windowMinutes = Math.min(Number(req.query.window) || 60, 60);
    res.json(obsGetTokenUsageByWorkspace(windowMinutes));
  });

  // Admin summary
  app.get("/api/admin/summary", adminRateLimiter, adminAuthOrQuery, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const users = await listAllUsers();
      const workspaces = await listAllWorkspaces();
      const usageSummary = await getSummary(7);
      const auditLog = getRecentAuditLog(50);
      const quotaOverrides = await getQuotaOverrides();

      const workspacesWithQuota = await Promise.all(
        workspaces.map(async ({ userId, workspace: ws }) => {
          const wsId = ws?.id || "default";
          const quota = await getWorkspaceQuota(wsId, null);
          const used = isQuotaConfigured() ? await getWorkspaceTokensUsed(wsId) : 0;
          return {
            userId,
            workspaceId: wsId,
            workspaceName: ws?.name || wsId,
            quota,
            tokensUsed: used,
            override: quotaOverrides[wsId],
          };
        })
      );

      const [health] = await Promise.all([runHealthChecks()]);
      const integrations = {
        github: Boolean(process.env.GITHUB_TOKEN),
        vercel: Boolean(process.env.VERCEL_TOKEN),
      };

      const apiKeys = listKeysForAdmin();

      res.json({
        users,
        workspaces: workspacesWithQuota,
        usage: usageSummary,
        auditLog,
        quotaOverrides,
        apiKeys,
        system: {
          health,
          integrations,
          quotaConfigured: isQuotaConfigured(),
          scheduleEnabled: process.env.ENABLE_SCHEDULED_RECIPES === "1",
        },
      });
    } catch (err) {
      console.error("Admin summary error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Quota override
  app.post("/api/admin/quotas/override", adminRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { workspace, limit } = req.body || {};
      const ws = sanitizeWorkspace(workspace);
      const result = await setWorkspaceQuotaOverride(ws, limit == null ? null : Number(limit));
      if (!result.ok) {
        return res.status(400).json({ error: result.error, code: "INVALID_INPUT" });
      }
      res.json(result);
    } catch (err) {
      console.error("Quota override error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Admin API key management
  // API key management
  app.get("/api/admin/keys", adminRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const keys = listKeysForAdmin();
      res.json({ keys });
    } catch (err) {
      console.error("Admin keys list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  app.post("/api/admin/keys", adminRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { userId, scopes } = req.body || {};
      const result = await addKey({ userId, scopes: Array.isArray(scopes) ? scopes : undefined });
      if (!result.ok) {
        return res.status(400).json({ error: result.error, code: "INVALID_INPUT" });
      }
      res.status(201).json(result);
    } catch (err) {
      console.error("Admin keys add error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  app.delete("/api/admin/keys/:id", adminRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const result = await revokeKey(req.params.id);
      if (!result.ok) {
        return res.status(404).json({ error: result.error || "Key not found", code: "NOT_FOUND" });
      }
      res.status(204).send();
    } catch (err) {
      console.error("Admin keys revoke error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Audit S3 archive
  app.post("/api/admin/audit/archive-s3", adminRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const out = await archiveExecutionAuditToS3();
      if (!out.ok) {
        return res.status(out.error?.includes("not set") ? 503 : 502).json({ error: out.error, code: "AUDIT_ARCHIVE_FAILED" });
      }
      res.json({ ok: true, key: out.key });
    } catch (err) {
      console.error("Admin audit archive error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  app.get("/api/admin/audit/archive-status", adminRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const status = await getAuditArchiveStatus();
      res.json(status);
    } catch (err) {
      console.error("Admin audit archive-status error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Audit lifecycle & query
  // Audit lifecycle
  const _auditLifecycle = new AuditLifecycle();

  app.get("/api/admin/audit/query", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const options = {};
      if (req.query.startDate || req.query.endDate) {
        options.dateRange = { start: req.query.startDate, end: req.query.endDate };
      }
      if (req.query.userId) options.userId = req.query.userId;
      if (req.query.action) options.action = req.query.action;
      if (req.query.workspaceId) options.workspaceId = req.query.workspaceId;
      if (req.query.level) options.level = req.query.level;
      if (req.query.cursor) options.cursor = Number(req.query.cursor);
      if (req.query.limit) options.limit = Number(req.query.limit);
      const result = await queryAudit(options);
      res.json(result);
    } catch (err) {
      console.error("Admin audit query error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  app.get("/api/admin/audit/export", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const options = {};
      if (req.query.startDate || req.query.endDate) {
        options.dateRange = { start: req.query.startDate, end: req.query.endDate };
      }
      if (req.query.userId) options.userId = req.query.userId;
      if (req.query.action) options.action = req.query.action;
      if (req.query.workspaceId) options.workspaceId = req.query.workspaceId;
      if (req.query.level) options.level = req.query.level;
      if (req.query.limit) options.limit = Number(req.query.limit);
      const format = req.query.format === "csv" ? "csv" : "json";
      const result = await exportAudit(options, format);
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.data);
    } catch (err) {
      console.error("Admin audit export error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  app.get("/api/admin/audit/retention", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      res.json(_auditLifecycle.getRetentionPolicy());
    } catch (err) {
      console.error("Admin audit retention get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  app.put("/api/admin/audit/retention", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const { retentionDays, archiveAfterDays, deleteAfterDays, bucketName } = req.body || {};
      _auditLifecycle.configure({ retentionDays, archiveAfterDays, deleteAfterDays, bucketName });
      res.json(_auditLifecycle.getRetentionPolicy());
    } catch (err) {
      console.error("Admin audit retention update error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  app.post("/api/admin/audit/archive-now", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const result = await _auditLifecycle.archiveOldEntries();
      if (result.error) {
        return res.status(502).json({ error: result.error, code: "ARCHIVE_FAILED" });
      }
      res.json(result);
    } catch (err) {
      console.error("Admin audit archive-now error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // A/B routing admin endpoints
  // Routing admin endpoints
  app.get("/api/routing/stats", adminRateLimiter, adminAuth, logRequest, (req, res) => {
    res.json({ stats: getRoutingStats(), enabled: AB_ROUTING_ENABLED });
  });

  app.get("/api/routing/config", adminRateLimiter, adminAuth, logRequest, (req, res) => {
    const config = AB_ROUTING_ENABLED
      ? MODEL_ROUTING_CONFIG.map((e) => ({ backend: e.backend, weight: e.weight }))
      : [];
    res.json({ enabled: AB_ROUTING_ENABLED, backends: config, raw: process.env.MODEL_ROUTING || "" });
  });

  // Multi-region & HA routes
  // Regions
  app.get("/api/regions", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const rh = getRegionHealth();
      await rh.checkRegions();
      const regions = rh.getRegionStatus();
      res.json({ ok: true, regions });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  app.get("/api/regions/leader", adminRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const le = getLeaderElection();
      const leader = await le.getLeader();
      res.json({ ok: true, leader });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // Internal sync
  app.post("/api/internal/sync", internalAuth, express.json(), async (req, res) => {
    try {
      const rm = getReplicationManager();
      const result = rm.receive(req.body);
      if (result.accepted) {
        res.json({ ok: true, accepted: true });
      } else {
        res.status(409).json({ ok: false, accepted: false, reason: result.reason });
      }
    } catch (err) {
      console.error("[replication] Sync receive error:", err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Admin HTML pages
  app.get("/admin", (req, res) => {
    res.sendFile(deps.__dirname + "/client/admin.html");
  });
}
