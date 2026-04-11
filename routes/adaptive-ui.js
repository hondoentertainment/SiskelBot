/**
 * Phase 69.2: Adaptive UI routes.
 */
import {
  recordFeatureUse,
  getSurfacedFeatures,
  rankFeatures,
  resetUsage,
  listUsers,
} from "../lib/adaptive-ui.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "adaptive-ui error");
}

export function mountAdaptiveUiRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/adaptive-ui/users/:userId/use", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const featureId = typeof body.featureId === "string" ? body.featureId : "";
      if (!featureId) return apiError(res, 400, "INVALID_INPUT", "featureId is required");
      const r = await recordFeatureUse(req.params.userId, featureId, body);
      return res.status(201).json({ _version: 1, feature: r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/adaptive-ui/users/:userId/surfaced", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 10;
      const r = await getSurfacedFeatures(req.params.userId, { limit });
      return res.json({ _version: 1, features: r, count: r.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/adaptive-ui/rank", log, auth, scope("read"), async (req, res) => {
    try {
      const r = rankFeatures(req.body?.features || {});
      return res.json({ _version: 1, features: r, count: r.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/adaptive-ui/users/:userId/reset", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const r = await resetUsage(req.params.userId, { featureId: body.featureId });
      return res.json({ _version: 1, ...r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/adaptive-ui/users", log, auth, scope("read"), async (_req, res) => {
    try {
      const users = await listUsers();
      return res.json({ _version: 1, users, count: users.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountAdaptiveUiRoutes;
