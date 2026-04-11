/**
 * Phase 57.1: Data pipeline routes.
 *
 * POST /api/v1/data-pipelines           -- create pipeline
 * GET  /api/v1/data-pipelines           -- list pipelines
 * POST /api/v1/data-pipelines/:id/run   -- run pipeline
 * GET  /api/v1/data-pipelines/runs/:id  -- fetch run status
 * POST /api/v1/data-pipelines/runs/:id/cancel -- cancel run
 * GET  /api/v1/data-pipelines/runs      -- list runs
 */
import {
  createPipeline,
  runPipeline,
  getPipelineStatus,
  cancelRun,
  listRuns,
  listPipelines,
} from "../lib/data-pipeline.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "data-pipeline error");
}

export function mountDataPipelineRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/data-pipelines", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const p = await createPipeline({ name: body.name, tasks: body.tasks });
      return res.status(201).json({ _version: 1, pipeline: p });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/data-pipelines", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listPipelines();
      return res.json({ _version: 1, pipelines: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/data-pipelines/:id/run", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const run = await runPipeline(req.params.id, body.inputs || {});
      return res.status(201).json({ _version: 1, run });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/data-pipelines/runs/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const run = await getPipelineStatus(req.params.id);
      if (!run) return apiError(res, 404, "NOT_FOUND", `run "${req.params.id}" not found`);
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/data-pipelines/runs/:id/cancel", log, auth, scope("write"), async (req, res) => {
    try {
      const run = await cancelRun(req.params.id);
      if (!run) return apiError(res, 404, "NOT_FOUND", `run "${req.params.id}" not found`);
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/data-pipelines/runs", log, auth, scope("read"), async (req, res) => {
    try {
      const pipelineId = typeof req.query.pipelineId === "string" ? req.query.pipelineId : undefined;
      const runs = await listRuns(pipelineId);
      return res.json({ _version: 1, runs, count: runs.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountDataPipelineRoutes;
