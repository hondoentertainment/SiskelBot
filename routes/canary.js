/**
 * Phase 59.4: Canary routes.
 *
 * POST /api/v1/canaries                -- body { name, stable, candidate, steps?, errorRateFloor?, minSuccessCount? }
 * GET  /api/v1/canaries                -- list all canaries
 * GET  /api/v1/canaries/:id            -- single-canary status
 * POST /api/v1/canaries/:id/tick       -- body { errorRate?, latencyMs? }
 * POST /api/v1/canaries/:id/rollback   -- body { reason? }
 */
import {
  createCanary,
  tickCanary,
  rollbackCanary,
  getCanaryStatus,
  listCanaries,
} from "../lib/canary.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "canary error");
}

export function mountCanaryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/canaries (admin-only)
  apiRoute("post", "/canaries", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const c = await createCanary({
        name: body.name,
        stable: body.stable,
        candidate: body.candidate,
        steps: body.steps,
        errorRateFloor: body.errorRateFloor,
        minSuccessCount: body.minSuccessCount,
      });
      return res.status(201).json({ _version: 1, canary: c });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/canaries
  apiRoute("get", "/canaries", log, auth, scope("read"), async (_req, res) => {
    try {
      const canaries = await listCanaries();
      return res.json({ _version: 1, canaries, count: canaries.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/canaries/:id
  apiRoute("get", "/canaries/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const c = await getCanaryStatus(req.params.id);
      if (!c) return apiError(res, 404, "NOT_FOUND", `canary not found: ${req.params.id}`);
      return res.json({ _version: 1, canary: c });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/canaries/:id/tick (admin-only)
  apiRoute("post", "/canaries/:id/tick", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const c = await tickCanary(req.params.id, {
        errorRate: Number(body.errorRate) || 0,
        latencyMs: Number(body.latencyMs) || 0,
      });
      return res.json({ _version: 1, canary: c });
    } catch (err) {
      return sendError(apiError, res, err, 404);
    }
  });

  // POST /api/v1/canaries/:id/rollback (admin-only)
  apiRoute("post", "/canaries/:id/rollback", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const c = await rollbackCanary(req.params.id, body.reason);
      return res.json({ _version: 1, canary: c });
    } catch (err) {
      return sendError(apiError, res, err, 404);
    }
  });
}

export default mountCanaryRoutes;
