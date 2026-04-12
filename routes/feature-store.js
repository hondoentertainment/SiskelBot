/**
 * Phase 57.5: Feature store routes.
 *
 * POST   /api/v1/features                              — define a feature
 * GET    /api/v1/features                              — list features
 * POST   /api/v1/features/:name/values                 — write a feature value
 * GET    /api/v1/features/:name/values/:entity         — read latest online value
 * POST   /api/v1/features/batch-read                   — batch-read
 * GET    /api/v1/features/:name/offline                — read offline log
 */
import {
  FEATURE_TYPES,
  defineFeature,
  writeFeature,
  readFeature,
  batchRead,
  listFeatures,
  readOffline,
} from "../lib/feature-store.js";

function mapErr(err) {
  if (/not defined|not found/i.test(err?.message || "")) return { status: 404, code: "NOT_FOUND" };
  if (/required|must be|does not match/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountFeatureStoreRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/features/types", adminAuth, logRequest, async (req, res) => {
    res.json({ types: FEATURE_TYPES });
  });

  apiRoute("post", "/features", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await defineFeature(req.body || {});
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/features", adminAuth, logRequest, async (req, res) => {
    res.json({ features: await listFeatures() });
  });

  apiRoute("post", "/features/:name/values", adminAuth, logRequest, async (req, res) => {
    try {
      const { entity, value, offline, timestamp } = req.body || {};
      if (entity == null) return apiError(res, 400, "INVALID_INPUT", "entity is required");
      const rec = await writeFeature(req.params.name, entity, value, { offline, timestamp });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/features/:name/values/:entity", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await readFeature(req.params.name, req.params.entity);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "value not found or expired");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/features/batch-read", adminAuth, logRequest, async (req, res) => {
    try {
      const requests = req.body?.requests;
      if (!Array.isArray(requests)) {
        return apiError(res, 400, "INVALID_INPUT", "requests array is required");
      }
      const results = await batchRead(requests);
      res.json({ results });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/features/:name/offline", adminAuth, logRequest, async (req, res) => {
    try {
      const entries = await readOffline(req.params.name, {
        since: req.query?.since ? Number(req.query.since) : undefined,
        until: req.query?.until ? Number(req.query.until) : undefined,
        entity: req.query?.entity,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ entries });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountFeatureStoreRoutes;
