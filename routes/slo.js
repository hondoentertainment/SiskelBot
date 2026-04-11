/**
 * Route module: Service Level Objectives (SLOs).
 *
 * GET    /api/v1/slo                   — list all SLOs with current status
 * GET    /api/v1/slo/:name             — single SLO detail
 * POST   /api/v1/slo                   — create/update an SLO
 * DELETE /api/v1/slo/:name             — delete an SLO
 * GET    /api/v1/slo/:name/burndown    — error-budget burn-down time series
 */

import { globalSLOTracker } from "../lib/slo-tracker.js";

export function mountSLORoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/slo
  apiRoute("get", "/slo", chatAuth, requireScope("read"), logRequest, (req, res) => {
    try {
      const items = globalSLOTracker.getAllSLOs();
      res.json({ items, count: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/slo/:name/burndown   (declared before /:name so it matches first)
  apiRoute("get", "/slo/:name/burndown", chatAuth, requireScope("read"), logRequest, (req, res) => {
    try {
      const { name } = req.params;
      const period = typeof req.query?.period === "string" ? req.query.period : undefined;
      const bucketsRaw = Number(req.query?.buckets);
      const buckets = Number.isFinite(bucketsRaw) && bucketsRaw > 0 ? bucketsRaw : 24;
      const data = globalSLOTracker.getBurnDown(name, period, buckets);
      if (!data) return apiError(res, 404, "SLO_NOT_FOUND", `SLO '${name}' not found`);
      res.json(data);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/slo/:name
  apiRoute("get", "/slo/:name", chatAuth, requireScope("read"), logRequest, (req, res) => {
    try {
      const { name } = req.params;
      const status = globalSLOTracker.getSLOStatus(name);
      if (!status) return apiError(res, 404, "SLO_NOT_FOUND", `SLO '${name}' not found`);
      res.json(status);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/slo
  apiRoute("post", "/slo", chatAuth, requireScope("write"), logRequest, (req, res) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!Number.isFinite(Number(body.target))) {
        return apiError(res, 400, "INVALID_INPUT", "target must be a number");
      }
      if (typeof body.metric !== "string" || !body.metric) {
        return apiError(res, 400, "INVALID_INPUT", "metric is required");
      }
      const config = {
        target: Number(body.target),
        metric: body.metric,
        window: body.window || "30d",
        operator: body.operator || "gte",
        description: typeof body.description === "string" ? body.description : undefined,
      };
      if (Number.isFinite(Number(body.percentile))) config.percentile = Number(body.percentile);
      if (Number.isFinite(Number(body.allowedFraction))) config.allowedFraction = Number(body.allowedFraction);
      const saved = globalSLOTracker.setSLO(name, config);
      const status = globalSLOTracker.getSLOStatus(name);
      res.status(201).json({ name, config: saved, status });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // DELETE /api/v1/slo/:name
  apiRoute("delete", "/slo/:name", chatAuth, requireScope("write"), logRequest, (req, res) => {
    try {
      const { name } = req.params;
      const ok = globalSLOTracker.deleteSLO(name);
      if (!ok) return apiError(res, 404, "SLO_NOT_FOUND", `SLO '${name}' not found`);
      res.json({ ok: true, name });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountSLORoutes;
