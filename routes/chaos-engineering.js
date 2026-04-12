/**
 * Phase 59.1: Chaos engineering routes.
 *
 * All endpoints require admin auth. They expose rule management, experiment
 * lifecycle, steady-state recording + hypothesis validation, and fault-history
 * observability.
 *
 * POST   /api/v1/chaos/rules
 * DELETE /api/v1/chaos/rules/:id
 * GET    /api/v1/chaos/rules
 * POST   /api/v1/chaos/experiments
 * POST   /api/v1/chaos/experiments/:id/start
 * POST   /api/v1/chaos/experiments/:id/stop
 * GET    /api/v1/chaos/experiments/:id
 * GET    /api/v1/chaos/experiments
 * POST   /api/v1/chaos/experiments/:id/metric
 * POST   /api/v1/chaos/experiments/:id/validate
 * GET    /api/v1/chaos/fault-history
 * GET    /api/v1/chaos/fault-types
 * POST   /api/v1/chaos/reset
 */

import {
  FAULT_TYPES,
  getDefaultInjector,
  createExperiment,
  startExperiment,
  stopExperiment,
  getExperiment,
  listExperiments,
  recordSteadyStateMetric,
  validateSteadyState,
  getFaultHistory,
} from "../lib/chaos-engineering.js";

export function mountChaosEngineeringRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // ─── Rules ────────────────────────────────────────────────────────────────

  // POST /api/v1/chaos/rules
  apiRoute("post", "/chaos/rules", adminAuth, logRequest, (req, res) => {
    try {
      const body = req.body || {};
      if (!body.type) {
        return apiError(res, 400, "INVALID_INPUT", "type is required.");
      }
      const injector = getDefaultInjector();
      const rule = injector.addRule({
        id: body.id,
        type: body.type,
        targetPattern: body.targetPattern,
        probability: body.probability,
        params: body.params,
        enabled: body.enabled,
      });
      res.status(201).json(rule);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // DELETE /api/v1/chaos/rules/:id
  apiRoute("delete", "/chaos/rules/:id", adminAuth, logRequest, (req, res) => {
    try {
      const injector = getDefaultInjector();
      const removed = injector.removeRule(req.params.id);
      if (!removed) return apiError(res, 404, "NOT_FOUND", `rule "${req.params.id}" not found.`);
      res.json({ ok: true, id: req.params.id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/chaos/rules
  apiRoute("get", "/chaos/rules", adminAuth, logRequest, (req, res) => {
    try {
      const injector = getDefaultInjector();
      const filter = {};
      if (req.query?.type) filter.type = String(req.query.type);
      if (req.query?.enabled !== undefined) filter.enabled = req.query.enabled === "true";
      res.json({ rules: injector.listRules(filter), stats: injector.getStats() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ─── Experiments ─────────────────────────────────────────────────────────

  // POST /api/v1/chaos/experiments
  apiRoute("post", "/chaos/experiments", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required.");
      }
      const exp = await createExperiment(body.name, body.config || {});
      res.status(201).json(exp);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/chaos/experiments/:id/start
  apiRoute("post", "/chaos/experiments/:id/start", adminAuth, logRequest, async (req, res) => {
    try {
      const exp = await startExperiment(req.params.id);
      res.json(exp);
    } catch (err) {
      if (/not found/.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/chaos/experiments/:id/stop
  apiRoute("post", "/chaos/experiments/:id/stop", adminAuth, logRequest, async (req, res) => {
    try {
      const exp = await stopExperiment(req.params.id);
      res.json(exp);
    } catch (err) {
      if (/not found/.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/chaos/experiments/:id
  apiRoute("get", "/chaos/experiments/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const exp = await getExperiment(req.params.id);
      if (!exp) return apiError(res, 404, "NOT_FOUND", `experiment "${req.params.id}" not found.`);
      res.json(exp);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/chaos/experiments
  apiRoute("get", "/chaos/experiments", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.status) filter.status = String(req.query.status);
      if (req.query?.name) filter.name = String(req.query.name);
      const experiments = await listExperiments(filter);
      res.json({ experiments });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/chaos/experiments/:id/metric
  apiRoute("post", "/chaos/experiments/:id/metric", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "metric name is required.");
      if (!Number.isFinite(Number(body.value))) {
        return apiError(res, 400, "INVALID_INPUT", "metric value must be a number.");
      }
      const entry = await recordSteadyStateMetric(req.params.id, {
        name: body.name,
        value: Number(body.value),
        at: body.at,
      });
      res.status(201).json(entry);
    } catch (err) {
      if (/not found/.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/chaos/experiments/:id/validate
  apiRoute("post", "/chaos/experiments/:id/validate", adminAuth, logRequest, async (req, res) => {
    try {
      const hypothesis = (req.body && req.body.hypothesis) || req.body || {};
      if (!hypothesis.metric || !hypothesis.op || hypothesis.threshold === undefined) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "hypothesis requires { metric, op, threshold }.",
        );
      }
      const result = await validateSteadyState(req.params.id, hypothesis);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ─── Observability / utility ─────────────────────────────────────────────

  // GET /api/v1/chaos/fault-history?experimentId=...
  apiRoute("get", "/chaos/fault-history", adminAuth, logRequest, async (req, res) => {
    try {
      const experimentId = req.query?.experimentId ? String(req.query.experimentId) : null;
      const events = await getFaultHistory(experimentId);
      res.json({ events });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/chaos/fault-types
  apiRoute("get", "/chaos/fault-types", adminAuth, logRequest, (_req, res) => {
    res.json({ faultTypes: FAULT_TYPES });
  });

  // POST /api/v1/chaos/reset
  apiRoute("post", "/chaos/reset", adminAuth, logRequest, (_req, res) => {
    try {
      getDefaultInjector().reset();
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountChaosEngineeringRoutes;
