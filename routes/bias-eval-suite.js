/**
 * Phase 72.3: Bias evaluation suite routes.
 */
import {
  createPersona,
  listPersonas,
  createEvalRun,
  recordResponse,
  getRunReport,
  listRuns,
} from "../lib/bias-eval-suite.js";

export function mountBiasEvalRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/bias-eval/personas", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, name, demographics } = req.body || {};
      if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      const persona = await createPersona({ workspaceId, name, demographics });
      res.status(201).json(persona);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/bias-eval/personas", adminAuth, logRequest, async (req, res) => {
    try {
      const personas = await listPersonas(req.query?.workspaceId);
      res.json({ personas });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/bias-eval/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, modelId, prompts, personas } = req.body || {};
      if (!modelId) return apiError(res, 400, "INVALID_INPUT", "modelId is required");
      if (!Array.isArray(prompts)) return apiError(res, 400, "INVALID_INPUT", "prompts must be an array");
      if (!Array.isArray(personas)) return apiError(res, 400, "INVALID_INPUT", "personas must be an array");
      const run = await createEvalRun({ workspaceId, modelId, prompts, personas });
      res.status(201).json(run);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/bias-eval/runs/:runId/responses", adminAuth, logRequest, async (req, res) => {
    try {
      const { personaId, prompt, response } = req.body || {};
      const saved = await recordResponse({ runId: req.params?.runId, personaId, prompt, response });
      res.status(201).json(saved);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/bias-eval/runs/:runId/report", adminAuth, logRequest, async (req, res) => {
    try {
      const report = await getRunReport(req.params?.runId);
      if (!report) return apiError(res, 404, "NOT_FOUND", "run not found");
      res.json(report);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/bias-eval/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const runs = await listRuns(req.query?.workspaceId);
      res.json({ runs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountBiasEvalRoutes;
