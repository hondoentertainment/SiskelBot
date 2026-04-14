/**
 * Phase 64.4: Experiment bridge routes.
 */
import {
  createExperiment,
  logMetric,
  logParams,
  logArtifact,
  getExperiment,
  listExperiments,
  compareExperiments,
} from "../lib/experiment-bridge.js";

export function mountExperimentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/experiments", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, name, config, tags } = req.body || {};
      if (typeof name !== "string" || !name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      const record = await createExperiment({ workspaceId, name, config, tags });
      res.status(201).json(record);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/experiments", adminAuth, logRequest, async (req, res) => {
    try {
      const entries = await listExperiments(req.query?.workspaceId);
      res.json({ experiments: entries });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/experiments/compare", adminAuth, logRequest, async (req, res) => {
    try {
      const { experimentIds } = req.body || {};
      if (!Array.isArray(experimentIds) || !experimentIds.length) {
        return apiError(res, 400, "INVALID_INPUT", "experimentIds must be a non-empty array");
      }
      const result = await compareExperiments(experimentIds);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/experiments/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const exp = await getExperiment(req.params.id);
      if (!exp) return apiError(res, 404, "NOT_FOUND", `experiment ${req.params.id} not found`);
      res.json(exp);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/experiments/:id/metrics", adminAuth, logRequest, async (req, res) => {
    try {
      const { metric, value, step } = req.body || {};
      if (typeof metric !== "string" || !metric.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "metric is required");
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return apiError(res, 400, "INVALID_INPUT", "value must be a finite number");
      }
      const result = await logMetric({ experimentId: req.params.id, metric, value, step });
      res.status(201).json(result);
    } catch (err) {
      if (/not found/.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/experiments/:id/params", adminAuth, logRequest, async (req, res) => {
    try {
      const { params } = req.body || {};
      if (!params || typeof params !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "params object is required");
      }
      const result = await logParams({ experimentId: req.params.id, params });
      res.status(200).json(result);
    } catch (err) {
      if (/not found/.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/experiments/:id/artifacts", adminAuth, logRequest, async (req, res) => {
    try {
      const { name, description, sizeBytes } = req.body || {};
      if (typeof name !== "string" || !name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      const result = await logArtifact({ experimentId: req.params.id, name, description, sizeBytes });
      res.status(201).json(result);
    } catch (err) {
      if (/not found/.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountExperimentRoutes;
