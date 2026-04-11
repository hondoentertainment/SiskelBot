/**
 * Route module: ML experiment tracking (Phase 38.4).
 *
 * GET    /api/v1/experiments                      — list experiments in workspace
 * POST   /api/v1/experiments                      — create experiment
 * GET    /api/v1/experiments/:id                  — get experiment
 * DELETE /api/v1/experiments/:id                  — delete experiment
 * POST   /api/v1/experiments/:id/runs             — start run
 * GET    /api/v1/experiments/:id/runs             — list runs
 * GET    /api/v1/experiments/:id/runs/best        — best run for a metric
 * GET    /api/v1/runs/:runId                      — get run
 * POST   /api/v1/runs/:runId/params               — log params
 * POST   /api/v1/runs/:runId/metrics              — log metrics
 * POST   /api/v1/runs/:runId/artifacts            — log artifact
 * PUT    /api/v1/runs/:runId/status               — set run status
 * GET    /api/v1/runs/:runId/metrics/:metric      — metric history
 * POST   /api/v1/runs/compare                     — compare runs
 */

import {
  createExperiment,
  getExperiment,
  listExperiments,
  deleteExperiment,
  startRun,
  getRun,
  listRuns,
  logParams,
  logMetrics,
  logArtifact,
  setRunStatus,
  getMetricHistory,
  getBestRun,
  compareRuns,
  searchRuns,
} from "../lib/experiments.js";

export function mountExperimentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/experiments?workspace=...
  apiRoute("get", "/experiments", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const items = await listExperiments(workspace);
      res.json({ experiments: items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/experiments
  apiRoute("post", "/experiments", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { name, description, tags, metadata } = req.body || {};
      if (!name || typeof name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required.");
      }
      const workspace = req.body?.workspace || req.query?.workspace || "default";
      const experiment = await createExperiment(name, workspace, { description, tags, metadata });
      res.status(201).json(experiment);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/experiments/:id
  apiRoute("get", "/experiments/:id", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const experiment = await getExperiment(req.params.id, workspace);
      if (!experiment) {
        return apiError(res, 404, "NOT_FOUND", "experiment not found");
      }
      res.json(experiment);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/experiments/:id
  apiRoute("delete", "/experiments/:id", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const ok = await deleteExperiment(req.params.id, workspace);
      if (!ok) return apiError(res, 404, "NOT_FOUND", "experiment not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/experiments/:id/runs
  apiRoute("post", "/experiments/:id/runs", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = req.body?.workspace || req.query?.workspace || "default";
      const { name, tags, baselineRunId } = req.body || {};
      const result = await startRun(req.params.id, {
        workspaceId: workspace,
        name,
        tags,
        baselineRunId,
      });
      res.status(201).json(result);
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : 500;
      return apiError(res, status, status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/experiments/:id/runs
  apiRoute("get", "/experiments/:id/runs", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const status = req.query?.status || null;
      const sortBy = req.query?.sortBy || "startedAt";
      const sortOrder = req.query?.sortOrder || "desc";
      const limit = Number(req.query?.limit) || 0;
      const runs = await listRuns(req.params.id, { workspaceId: workspace, status, sortBy, sortOrder, limit });
      res.json({ runs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/experiments/:id/runs/best?metric=accuracy&direction=max
  apiRoute("get", "/experiments/:id/runs/best", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const metric = req.query?.metric;
      if (!metric) {
        return apiError(res, 400, "INVALID_INPUT", "metric query parameter is required.");
      }
      const direction = req.query?.direction === "min" ? "min" : "max";
      const best = await getBestRun(req.params.id, metric, direction, { workspaceId: workspace });
      if (!best) return apiError(res, 404, "NOT_FOUND", "no runs with this metric");
      res.json(best);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/runs/compare
  apiRoute("post", "/runs/compare", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const { runIds } = req.body || {};
      if (!Array.isArray(runIds) || runIds.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "runIds must be a non-empty array.");
      }
      const comparison = await compareRuns(runIds);
      res.json(comparison);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/runs/search
  apiRoute("post", "/runs/search", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.body?.workspace || req.query?.workspace || "default";
      const results = await searchRuns({ ...req.body, workspaceId: workspace });
      res.json({ runs: results });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/runs/:runId
  apiRoute("get", "/runs/:runId", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const run = await getRun(req.params.runId);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      res.json(run);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/runs/:runId/params
  apiRoute("post", "/runs/:runId/params", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { params } = req.body || {};
      if (!params || typeof params !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "params object is required.");
      }
      await logParams(req.params.runId, params);
      res.json({ ok: true });
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404
        : /immutable/i.test(err.message) ? 409
        : 500;
      const code = status === 404 ? "NOT_FOUND"
        : status === 409 ? "CONFLICT"
        : "INTERNAL_ERROR";
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/runs/:runId/metrics
  apiRoute("post", "/runs/:runId/metrics", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { metrics, step } = req.body || {};
      if (!metrics || typeof metrics !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "metrics object is required.");
      }
      await logMetrics(req.params.runId, metrics, step);
      res.json({ ok: true });
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : 500;
      return apiError(res, status, status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/runs/:runId/artifacts
  apiRoute("post", "/runs/:runId/artifacts", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { name, path, metadata } = req.body || {};
      if (!name || typeof name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required.");
      }
      await logArtifact(req.params.runId, name, path, metadata || {});
      res.json({ ok: true });
    } catch (err) {
      const status = /not found/i.test(err.message) ? 404 : 500;
      return apiError(res, status, status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/runs/:runId/status
  apiRoute("put", "/runs/:runId/status", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { status } = req.body || {};
      if (!status || typeof status !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "status is required.");
      }
      await setRunStatus(req.params.runId, status);
      res.json({ ok: true, status });
    } catch (err) {
      const code = /not found/i.test(err.message) ? 404
        : /must be one of/i.test(err.message) ? 400
        : 500;
      const ecode = code === 404 ? "NOT_FOUND"
        : code === 400 ? "INVALID_INPUT"
        : "INTERNAL_ERROR";
      return apiError(res, code, ecode, err.message);
    }
  });

  // GET /api/v1/runs/:runId/metrics/:metric
  apiRoute("get", "/runs/:runId/metrics/:metric", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const history = await getMetricHistory(req.params.runId, req.params.metric);
      res.json({ metric: req.params.metric, points: history });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountExperimentRoutes;
