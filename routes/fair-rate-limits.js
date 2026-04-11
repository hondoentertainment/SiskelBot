/**
 * Phase 66.3: Fair rate limits routes.
 *
 * POST   /api/v1/fair-rate-limits/tenants            -- register tenant
 * GET    /api/v1/fair-rate-limits/tenants            -- list tenants
 * POST   /api/v1/fair-rate-limits/tenants/:id/acquire -- tryAcquire
 * POST   /api/v1/fair-rate-limits/tenants/:id/release -- releaseSlot
 * POST   /api/v1/fair-rate-limits/weights            -- bulk set weights
 * GET    /api/v1/fair-rate-limits/queue              -- current queue
 */
import {
  registerTenant,
  tryAcquire,
  getQueue,
  setWeights,
  listTenants,
  releaseSlot,
} from "../lib/fair-rate-limits.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "fair-rate-limits error");
}

export function mountFairRateLimitsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/fair-rate-limits/tenants", log, admin, async (req, res) => {
    try {
      const rec = await registerTenant(req.body || {});
      return res.status(201).json({ _version: 1, tenant: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/fair-rate-limits/tenants", log, auth, scope("read"), async (req, res) => {
    try {
      const includeStats = req.query.stats === "1" || req.query.stats === "true";
      const items = listTenants({ includeStats });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/fair-rate-limits/tenants/:id/acquire", log, auth, scope("write"), async (req, res) => {
    try {
      const result = tryAcquire(req.params.id);
      return res.json({ _version: 1, result });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not registered") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/fair-rate-limits/tenants/:id/release", log, auth, scope("write"), async (req, res) => {
    try {
      const ok = releaseSlot(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `tenant ${req.params.id} not found`);
      return res.json({ _version: 1, released: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/fair-rate-limits/weights", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const updates = Array.isArray(body.updates) ? body.updates : Array.isArray(body) ? body : [];
      const results = await setWeights(updates);
      return res.json({ _version: 1, updated: results });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/fair-rate-limits/queue", log, admin, async (_req, res) => {
    try {
      return res.json({ _version: 1, ...getQueue() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountFairRateLimitsRoutes;
