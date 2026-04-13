/**
 * Phase 57.1: DAG pipeline routes.
 *
 * POST   /api/v1/dag-pipelines              — create pipeline
 * GET    /api/v1/dag-pipelines              — list pipelines
 * GET    /api/v1/dag-pipelines/:id          — get pipeline
 * DELETE /api/v1/dag-pipelines/:id          — delete pipeline
 * POST   /api/v1/dag-pipelines/:id/run      — start a run
 * GET    /api/v1/dag-pipelines/runs         — list runs
 * GET    /api/v1/dag-pipelines/runs/:runId  — get run status
 * GET    /api/v1/dag-pipelines/tasks        — list registered tasks
 */
import {
  createPipeline,
  getPipeline,
  listPipelines,
  deletePipeline,
  runPipeline,
  getRunStatus,
  listRuns,
  listTasks,
} from "../lib/dag-pipeline.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required|must be|cycle|unknown/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountDagPipelineRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/dag-pipelines/tasks", adminAuth, logRequest, async (req, res) => {
    res.json({ tasks: listTasks() });
  });

  apiRoute("post", "/dag-pipelines", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await createPipeline(req.body || {});
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/dag-pipelines", adminAuth, logRequest, async (req, res) => {
    try {
      const pipelines = await listPipelines();
      res.json({ pipelines });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/dag-pipelines/runs", adminAuth, logRequest, async (req, res) => {
    try {
      const runs = await listRuns();
      res.json({ runs });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/dag-pipelines/runs/:runId", adminAuth, logRequest, async (req, res) => {
    try {
      const run = await getRunStatus(req.params.runId);
      res.json(run);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/dag-pipelines/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getPipeline(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "pipeline not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("delete", "/dag-pipelines/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deletePipeline(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "pipeline not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/dag-pipelines/:id/run", adminAuth, logRequest, async (req, res) => {
    try {
      const run = await runPipeline(req.params.id, {
        context: req.body?.context,
        runId: req.body?.runId,
      });
      res.status(202).json(run);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountDagPipelineRoutes;
