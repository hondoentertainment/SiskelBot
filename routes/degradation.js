/**
 * Phase 59.3: Degradation tier routes.
 *
 * POST /api/v1/degradation/tier          -- body { tier, reason?, actor? }
 * GET  /api/v1/degradation/tier
 * POST /api/v1/degradation/features      -- body { name, tier, description?, enabled? }
 * GET  /api/v1/degradation/features
 * GET  /api/v1/degradation/features/:name
 * GET  /api/v1/degradation/history
 */
import {
  setTier,
  getTier,
  isFeatureEnabled,
  registerFeature,
  listFeatures,
  getTierHistory,
} from "../lib/degradation.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "degradation error");
}

export function mountDegradationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/degradation/tier (admin-only)
  apiRoute("post", "/degradation/tier", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.tier) {
        return apiError(res, 400, "INVALID_INPUT", "tier is required");
      }
      const out = await setTier(body.tier, { reason: body.reason, actor: body.actor });
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/degradation/tier
  apiRoute("get", "/degradation/tier", log, auth, scope("read"), async (_req, res) => {
    try {
      const tier = await getTier();
      return res.json({ _version: 1, tier });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/degradation/features (admin-only)
  apiRoute("post", "/degradation/features", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const f = await registerFeature({
        name: body.name,
        tier: body.tier,
        description: body.description,
        enabled: body.enabled,
      });
      return res.status(201).json({ _version: 1, feature: f });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/degradation/features
  apiRoute("get", "/degradation/features", log, auth, scope("read"), async (_req, res) => {
    try {
      const features = await listFeatures();
      return res.json({ _version: 1, features, count: features.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/degradation/features/:name
  apiRoute("get", "/degradation/features/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const enabled = await isFeatureEnabled(req.params.name);
      return res.json({ _version: 1, name: req.params.name, enabled });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/degradation/history
  apiRoute("get", "/degradation/history", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 50;
      const history = await getTierHistory(limit);
      return res.json({ _version: 1, history, count: history.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountDegradationRoutes;
