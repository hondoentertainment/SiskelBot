/**
 * Phase 58.1: Cost-aware router routes.
 *
 * POST /api/v1/cost-router/models          -- body { id, inputPer1k, outputPer1k, quality?, provider?, region? }
 * GET  /api/v1/cost-router/models          -- list registered model prices
 * POST /api/v1/cost-router/route           -- body { inputTokens, outputTokens, qualityFloor?, candidates?, provider?, region? }
 * POST /api/v1/cost-router/estimate        -- body { model, inputTokens, outputTokens }
 * POST /api/v1/cost-router/spend           -- body { model, amount }
 * GET  /api/v1/cost-router/spend           -- list cumulative spend
 */
import {
  registerModelPrice,
  routeByCost,
  estimateRequestCost,
  listPrices,
  recordSpend,
  listSpend,
} from "../lib/cost-router.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "cost-router error");
}

export function mountCostRouterRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/cost-router/models
  apiRoute("post", "/cost-router/models", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.id || typeof body.id !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "id is required");
      }
      const rec = await registerModelPrice(body.id, {
        inputPer1k: body.inputPer1k,
        outputPer1k: body.outputPer1k,
        quality: body.quality,
        provider: body.provider,
        region: body.region,
      });
      return res.status(201).json({ _version: 1, model: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/cost-router/models
  apiRoute("get", "/cost-router/models", log, auth, scope("read"), async (_req, res) => {
    try {
      const models = await listPrices();
      return res.json({ _version: 1, models, count: models.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/cost-router/route
  apiRoute("post", "/cost-router/route", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const request = {
        inputTokens: Number(body.inputTokens) || 0,
        outputTokens: Number(body.outputTokens) || 0,
      };
      const options = {};
      if (Number.isFinite(body.qualityFloor)) options.qualityFloor = Number(body.qualityFloor);
      if (Array.isArray(body.candidates)) options.candidates = body.candidates;
      if (body.provider) options.provider = String(body.provider);
      if (body.region) options.region = String(body.region);
      const result = await routeByCost(request, options);
      if (!result) {
        return apiError(res, 404, "NOT_FOUND", "no model meets the given criteria");
      }
      return res.json({ _version: 1, routed: result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/cost-router/estimate
  apiRoute("post", "/cost-router/estimate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.model || typeof body.model !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "model is required");
      }
      const cost = await estimateRequestCost(body.model, {
        inputTokens: Number(body.inputTokens) || 0,
        outputTokens: Number(body.outputTokens) || 0,
      });
      return res.json({ _version: 1, model: body.model, cost });
    } catch (err) {
      return sendError(apiError, res, err, 404);
    }
  });

  // POST /api/v1/cost-router/spend
  apiRoute("post", "/cost-router/spend", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.model || typeof body.model !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "model is required");
      }
      const entry = await recordSpend(body.model, Number(body.amount));
      return res.status(201).json({ _version: 1, spend: entry });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/cost-router/spend
  apiRoute("get", "/cost-router/spend", log, auth, scope("read"), async (_req, res) => {
    try {
      const spend = await listSpend();
      return res.json({ _version: 1, spend, count: spend.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountCostRouterRoutes;
