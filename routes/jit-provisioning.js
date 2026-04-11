/**
 * Phase 46.3: Just-in-time user provisioning routes.
 *
 * Routes:
 *   GET  /api/v1/jit/config?workspace=X            — fetch JIT config for a workspace
 *   PUT  /api/v1/jit/config                         — update JIT config (admin)
 *   GET  /api/v1/jit/users/provisioned?workspace=X  — list JIT-provisioned users
 *   POST /api/v1/jit/users/:id/deprovision          — soft-delete a JIT user (admin)
 *   GET  /api/v1/jit/audit?workspace=X              — provisioning audit log
 */
import {
  getJITConfig,
  setJITConfig,
  listProvisionedUsers,
  deprovisionUser,
  listAuditLog,
} from "../lib/jit-provisioning.js";

export function mountJitProvisioningRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    storageRateLimiter,
    userAuth,
    adminAuth,
    requireScope,
  } = deps;

  const limiter = storageRateLimiter || ((_req, _res, next) => next());
  const scopeRead = requireScope ? requireScope("read") : (_req, _res, next) => next();
  const scopeWrite = requireScope ? requireScope("write") : (_req, _res, next) => next();
  const log = logRequest || ((_req, _res, next) => next());
  const requireUser = userAuth || ((_req, _res, next) => next());
  const requireAdmin = adminAuth || ((_req, _res, next) => next());

  // GET /api/v1/jit/config?workspace=X
  apiRoute("get", "/jit/config", limiter, requireUser, scopeRead, log, async (req, res) => {
    try {
      const workspaceId = String(req.query?.workspace || "default");
      const config = await getJITConfig(workspaceId);
      res.json({ _version: 1, workspaceId, config });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to load JIT config.");
    }
  });

  // PUT /api/v1/jit/config
  apiRoute("put", "/jit/config", limiter, requireAdmin, scopeWrite, log, async (req, res) => {
    try {
      const workspaceId = String(req.body?.workspace || req.body?.workspaceId || "default");
      const cfg = req.body?.config || req.body || {};
      const allowed = {};
      if (cfg.enabled !== undefined) allowed.enabled = Boolean(cfg.enabled);
      if (cfg.defaultRole !== undefined) allowed.defaultRole = String(cfg.defaultRole);
      if (cfg.groupMapping !== undefined && typeof cfg.groupMapping === "object") {
        allowed.groupMapping = cfg.groupMapping;
      }
      if (cfg.attributeMapping !== undefined && typeof cfg.attributeMapping === "object") {
        allowed.attributeMapping = cfg.attributeMapping;
      }
      if (Array.isArray(cfg.requiredAttributes)) {
        allowed.requiredAttributes = cfg.requiredAttributes;
      }
      if (cfg.createWorkspace !== undefined) allowed.createWorkspace = Boolean(cfg.createWorkspace);

      const stored = await setJITConfig(workspaceId, allowed);
      const merged = await getJITConfig(workspaceId);
      res.json({ _version: 1, workspaceId, config: merged, stored });
    } catch (err) {
      if (/Invalid defaultRole/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to update JIT config.");
    }
  });

  // GET /api/v1/jit/users/provisioned?workspace=X
  apiRoute(
    "get",
    "/jit/users/provisioned",
    limiter,
    requireUser,
    scopeRead,
    log,
    async (req, res) => {
      try {
        const workspaceId = req.query?.workspace ? String(req.query.workspace) : null;
        const users = await listProvisionedUsers(workspaceId);
        res.json({
          _version: 1,
          workspaceId: workspaceId || null,
          count: users.length,
          users,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to list provisioned users.");
      }
    }
  );

  // POST /api/v1/jit/users/:id/deprovision
  apiRoute(
    "post",
    "/jit/users/:id/deprovision",
    limiter,
    requireAdmin,
    log,
    async (req, res) => {
      try {
        const userId = String(req.params.id || "").trim();
        if (!userId) {
          return apiError(res, 400, "INVALID_INPUT", "user id required");
        }
        const reason = req.body?.reason || "manual";
        const result = await deprovisionUser(userId, reason);
        if (!result.deprovisioned) {
          return apiError(res, 404, "NOT_FOUND", `User ${userId} not found`);
        }
        res.json({ _version: 1, ...result });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to deprovision user.");
      }
    }
  );

  // GET /api/v1/jit/audit?workspace=X
  apiRoute("get", "/jit/audit", limiter, requireUser, scopeRead, log, async (req, res) => {
    try {
      const workspaceId = req.query?.workspace ? String(req.query.workspace) : null;
      const limit = req.query?.limit ? Number(req.query.limit) : 100;
      const items = await listAuditLog(workspaceId, limit);
      res.json({ _version: 1, workspaceId: workspaceId || null, count: items.length, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to load JIT audit log.");
    }
  });
}

export default mountJitProvisioningRoutes;
