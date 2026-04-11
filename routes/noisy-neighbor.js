/**
 * Phase 66.2: Noisy neighbor routes.
 *
 * POST   /api/v1/noisy-neighbor/usage                 -- { tenantId, metric, value }
 * POST   /api/v1/noisy-neighbor/detect                -- { metric?, zThreshold?, madThreshold?, method?, minSamples? }
 * POST   /api/v1/noisy-neighbor/throttle/:tenantId    -- { reason?, until?, actor? }
 * DELETE /api/v1/noisy-neighbor/throttle/:tenantId    -- unthrottle
 * GET    /api/v1/noisy-neighbor/throttled             -- list throttled
 */
import {
  recordUsage,
  detectOutliers,
  throttleTenant,
  unthrottleTenant,
  listThrottled,
} from "../lib/noisy-neighbor.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "noisy-neighbor error");
}

export function mountNoisyNeighborRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/noisy-neighbor/usage", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await recordUsage(body.tenantId, body.metric, body.value);
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/noisy-neighbor/detect", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const items = await detectOutliers(body);
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/noisy-neighbor/throttle/:tenantId", log, admin, async (req, res) => {
    try {
      const rec = await throttleTenant(req.params.tenantId, req.body || {});
      return res.status(201).json({ _version: 1, throttle: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("delete", "/noisy-neighbor/throttle/:tenantId", log, admin, async (req, res) => {
    try {
      const ok = await unthrottleTenant(req.params.tenantId);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `tenant ${req.params.tenantId} not throttled`);
      return res.json({ _version: 1, unthrottled: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/noisy-neighbor/throttled", log, admin, async (_req, res) => {
    try {
      const items = await listThrottled();
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountNoisyNeighborRoutes;
