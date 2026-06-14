/**
 * Phase 75.1: Eval-in-prod (shadow traffic) routes.
 *
 * POST /eval-in-prod/samples   — record a shadow sample
 * GET  /eval-in-prod/samples   — list samples for a workspace
 * GET  /eval-in-prod/stats     — aggregate stats
 * GET  /eval-in-prod/config    — get shadow config
 * PUT  /eval-in-prod/config    — update shadow config
 */
import {
  recordShadowSample,
  querySamples,
  getShadowStats,
  getShadowConfig,
  setShadowConfig,
  evaluateQualityAlerts,
  dispatchQualityAlerts,
} from "../lib/eval-in-prod.js";

export function mountEvalInProdRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/eval-in-prod/samples", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await recordShadowSample(body);
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/eval-in-prod/samples", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await querySamples({
        workspaceId: req.query?.workspaceId,
        candidateModel: req.query?.candidateModel,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/eval-in-prod/stats", adminAuth, logRequest, async (req, res) => {
    try {
      const stats = await getShadowStats({
        workspaceId: req.query?.workspaceId,
        candidateModel: req.query?.candidateModel,
      });
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/eval-in-prod/config", adminAuth, logRequest, async (req, res) => {
    try {
      const cfg = await getShadowConfig(req.query?.workspaceId);
      res.json(cfg);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/eval-in-prod/config", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId is required");
      }
      const cfg = await setShadowConfig(body);
      res.json(cfg);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/eval-in-prod/alerts", adminAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId;
      if (!workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId is required");
      }
      const dispatch = req.query?.dispatch === "1" || req.query?.dispatch === "true";
      const opts = {
        workspaceId,
        sinceMs: req.query?.since ? Number(req.query.since) : undefined,
        minAvgJaccard: req.query?.minJaccard ? Number(req.query.minJaccard) : undefined,
        minIdenticalRatio: req.query?.minIdentical ? Number(req.query.minIdentical) : undefined,
        minSamples: req.query?.minSamples ? Number(req.query.minSamples) : undefined,
      };
      const out = dispatch ? await dispatchQualityAlerts(opts) : await evaluateQualityAlerts(opts);
      res.json(out);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}

export default mountEvalInProdRoutes;
