/**
 * Phase 57.5: Feature store routes.
 *
 * POST   /api/v1/features                      -- register feature
 * GET    /api/v1/features                      -- list features
 * DELETE /api/v1/features/:name                -- delete feature
 * POST   /api/v1/features/:name/:entityId      -- write feature value
 * GET    /api/v1/features/:name/:entityId      -- read feature value
 * POST   /api/v1/features/batch/:entityId      -- batch read
 * GET    /api/v1/features/:name/:entityId/history -- offline history
 */
import {
  registerFeature,
  writeFeature,
  readFeature,
  listFeatures,
  batchReadFeatures,
  getOfflineHistory,
  deleteFeature,
} from "../lib/feature-store.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "feature-store error");
}

export function mountFeatureStoreRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/features", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const feat = await registerFeature(body);
      return res.status(201).json({ _version: 1, feature: feat });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/features", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listFeatures();
      return res.json({ _version: 1, features: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/features/:name", log, auth, scope("write"), async (req, res) => {
    try {
      const ok = await deleteFeature(req.params.name);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `feature "${req.params.name}" not found`);
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/features/batch/:entityId", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.names)) {
        return apiError(res, 400, "INVALID_INPUT", "names array required");
      }
      const out = await batchReadFeatures(body.names, req.params.entityId);
      return res.json({ _version: 1, features: out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/features/:name/:entityId/history", log, auth, scope("read"), async (req, res) => {
    try {
      const hist = await getOfflineHistory(req.params.name, req.params.entityId);
      return res.json({ _version: 1, history: hist, count: hist.length });
    } catch (err) {
      const status = /unknown feature/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/features/:name/:entityId", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (body.value === undefined) {
        return apiError(res, 400, "INVALID_INPUT", "value required");
      }
      const out = await writeFeature(req.params.name, req.params.entityId, body.value, {
        timestamp: body.timestamp,
      });
      return res.status(201).json({ _version: 1, write: out });
    } catch (err) {
      const status = /unknown feature/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/features/:name/:entityId", log, auth, scope("read"), async (req, res) => {
    try {
      const allowStale = String(req.query.allowStale || "").toLowerCase() === "true";
      const out = await readFeature(req.params.name, req.params.entityId, { allowStale });
      return res.json({ _version: 1, feature: out });
    } catch (err) {
      const status = /unknown feature/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });
}

export default mountFeatureStoreRoutes;
