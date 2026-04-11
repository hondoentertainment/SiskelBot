/**
 * Phase 66.1: Resource isolation routes.
 *
 * PUT    /api/v1/resource-isolation/:tenantId/limits   -- set limits
 * GET    /api/v1/resource-isolation/:tenantId/limits   -- get limits
 * POST   /api/v1/resource-isolation/:tenantId/usage    -- record { resourceType, amount, mode? }
 * POST   /api/v1/resource-isolation/:tenantId/check    -- { resourceType, amount }
 * POST   /api/v1/resource-isolation/:tenantId/reset    -- { resources? }
 * GET    /api/v1/resource-isolation                    -- list all tenants
 */
import {
  setLimits,
  getLimits,
  recordUsage,
  checkQuota,
  listTenantUsage,
  resetUsage,
} from "../lib/resource-isolation.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "resource-isolation error");
}

export function mountResourceIsolationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("put", "/resource-isolation/:tenantId/limits", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const limits = body.limits && typeof body.limits === "object" ? body.limits : body;
      const result = await setLimits(req.params.tenantId, limits);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/resource-isolation/:tenantId/limits", log, auth, scope("read"), async (req, res) => {
    try {
      const result = await getLimits(req.params.tenantId);
      if (!result) return apiError(res, 404, "NOT_FOUND", `tenant ${req.params.tenantId} not found`);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/resource-isolation/:tenantId/usage", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.resourceType) return apiError(res, 400, "INVALID_INPUT", "resourceType required");
      const mode = body.mode === "set" ? "set" : "add";
      const result = await recordUsage(req.params.tenantId, body.resourceType, body.amount, { mode });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/resource-isolation/:tenantId/check", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.resourceType) return apiError(res, 400, "INVALID_INPUT", "resourceType required");
      const result = await checkQuota(req.params.tenantId, body.resourceType, body.amount || 0);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/resource-isolation/:tenantId/reset", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const resources = Array.isArray(body.resources) ? body.resources : undefined;
      const result = await resetUsage(req.params.tenantId, resources);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/resource-isolation", log, admin, async (req, res) => {
    try {
      const overLimitOnly = req.query.overLimitOnly === "1" || req.query.overLimitOnly === "true";
      const items = await listTenantUsage({ overLimitOnly });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountResourceIsolationRoutes;
