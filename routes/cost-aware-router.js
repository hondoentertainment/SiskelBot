/**
 * Phase 58.1: Cost-aware router routes.
 *
 * POST   /api/v1/cost-router/pick       — pick a model from candidates
 * POST   /api/v1/cost-router/cost       — record a cost/usage entry
 * GET    /api/v1/cost-router/report     — aggregated cost report
 * POST   /api/v1/cost-router/config     — save cost configuration string
 * GET    /api/v1/cost-router/config     — load saved cost configuration
 */
import {
  pickModel,
  recordCost,
  getCostReport,
  saveCostConfig,
  loadCostConfig,
} from "../lib/cost-aware-router.js";

export function mountCostAwareRouterRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/cost-router/pick", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.candidates)) {
        return apiError(res, 400, "INVALID_INPUT", "candidates array is required");
      }
      const result = pickModel(body.candidates, {
        qualityFloor: body.qualityFloor,
        strategy: body.strategy,
        maxCostPerKTokens: body.maxCostPerKTokens,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/cost-router/cost", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await recordCost(req.body || {});
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/cost-router/report", adminAuth, logRequest, async (req, res) => {
    try {
      const report = await getCostReport({
        since: req.query?.since ? Number(req.query.since) : undefined,
        until: req.query?.until ? Number(req.query.until) : undefined,
        model: req.query?.model,
        workspaceId: req.query?.workspaceId,
        userId: req.query?.userId,
      });
      res.json(report);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/cost-router/config", adminAuth, logRequest, async (req, res) => {
    try {
      const configString = req.body?.configString;
      if (typeof configString !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "configString string is required");
      }
      await saveCostConfig(configString);
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/cost-router/config", adminAuth, logRequest, async (req, res) => {
    try {
      const cfg = await loadCostConfig();
      res.json({ configString: cfg });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountCostAwareRouterRoutes;
