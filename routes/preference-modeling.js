/**
 * Phase 69.1: Preference modeling routes.
 */
import {
  recordPreference,
  getUserProfile,
  updateProfile,
  listPreferences,
  mergePreferences,
} from "../lib/preference-modeling.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "preference-modeling error");
}

export function mountPreferenceModelingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/preferences/:userId/signal", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await recordPreference(req.params.userId, req.body || {});
      return res.status(201).json({ _version: 1, profile: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/preferences/:userId", log, auth, scope("read"), async (req, res) => {
    try {
      const p = await getUserProfile(req.params.userId);
      return res.json({ _version: 1, profile: p });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("put", "/preferences/:userId", log, auth, scope("write"), async (req, res) => {
    try {
      const p = await updateProfile(req.params.userId, req.body || {});
      return res.json({ _version: 1, profile: p });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/preferences/:userId/list", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = Number.isFinite(Number(req.query?.limit)) ? Number(req.query.limit) : 20;
      const items = await listPreferences(req.params.userId, { limit });
      return res.json({ _version: 1, preferences: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/preferences/merge", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.targetUserId || !body.sourceUserId) {
        return apiError(res, 400, "INVALID_INPUT", "targetUserId and sourceUserId are required");
      }
      const p = await mergePreferences(body.targetUserId, body.sourceUserId);
      return res.json({ _version: 1, profile: p });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountPreferenceModelingRoutes;
