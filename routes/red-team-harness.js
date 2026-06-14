/**
 * Phase 72.1: Red-team harness routes.
 */
import {
  listCategories,
  generateProbes,
  createRun,
  recordProbeResult,
  getRun,
  listRuns,
  getRunSummary,
} from "../lib/red-team-harness.js";

export function mountRedTeamRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/red-team/categories", adminAuth, logRequest, async (req, res) => {
    try {
      res.json({ categories: listCategories() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/red-team/probes", adminAuth, logRequest, async (req, res) => {
    try {
      const { category, count, seed } = req.body || {};
      if (!category) return apiError(res, 400, "INVALID_INPUT", "category is required");
      const probes = generateProbes({ category, count, seed });
      res.status(200).json({ probes });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/red-team/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, modelId, categories, probeCount } = req.body || {};
      if (!modelId) return apiError(res, 400, "INVALID_INPUT", "modelId is required");
      const run = await createRun({ workspaceId, modelId, categories, probeCount });
      res.status(201).json(run);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/red-team/runs/:runId/results", adminAuth, logRequest, async (req, res) => {
    try {
      const { runId } = req.params || {};
      const { probeId, response, blocked, classifierScore } = req.body || {};
      if (!probeId) return apiError(res, 400, "INVALID_INPUT", "probeId is required");
      const result = await recordProbeResult({ runId, probeId, response, blocked, classifierScore });
      res.status(201).json(result);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/red-team/runs/:runId", adminAuth, logRequest, async (req, res) => {
    try {
      const run = await getRun(req.params?.runId);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      res.json(run);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/red-team/runs/:runId/summary", adminAuth, logRequest, async (req, res) => {
    try {
      const summary = await getRunSummary(req.params?.runId);
      if (!summary) return apiError(res, 404, "NOT_FOUND", "run not found");
      res.json(summary);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/red-team/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const runs = await listRuns(req.query?.workspaceId);
      res.json({ runs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountRedTeamRoutes;
