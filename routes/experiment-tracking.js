/**
 * Phase 64.4: Experiment tracking routes.
 */
import {
  createExperiment,
  startRun,
  logParam,
  logMetric,
  endRun,
  listRuns,
  getRun,
  listExperiments,
  compareRuns,
} from "../lib/experiment-tracking.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "experiment-tracking error");
}

export function mountExperimentTrackingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/research/experiments", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "name required");
      const exp = await createExperiment(body.name, body);
      return res.status(201).json({ _version: 1, experiment: exp });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/research/experiments", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listExperiments();
      return res.json({ _version: 1, experiments: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/research/experiments/:id/runs", log, auth, scope("write"), async (req, res) => {
    try {
      const run = await startRun(req.params.id, req.body || {});
      return res.status(201).json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/research/runs", log, auth, scope("read"), async (req, res) => {
    try {
      const experimentId = typeof req.query.experimentId === "string" ? req.query.experimentId : undefined;
      const runs = await listRuns(experimentId);
      return res.json({ _version: 1, runs, count: runs.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/research/runs/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const run = await getRun(req.params.id);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/research/runs/:id/params", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.key) return apiError(res, 400, "INVALID_INPUT", "key required");
      const run = await logParam(req.params.id, body.key, body.value);
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/research/runs/:id/metrics", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.key) return apiError(res, 400, "INVALID_INPUT", "key required");
      const run = await logMetric(req.params.id, body.key, Number(body.value), body.step);
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/research/runs/:id/end", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const run = await endRun(req.params.id, body.status || "finished");
      return res.json({ _version: 1, run });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/research/runs/compare", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.runIds)) return apiError(res, 400, "INVALID_INPUT", "runIds required");
      if (!body.metric) return apiError(res, 400, "INVALID_INPUT", "metric required");
      const out = await compareRuns(body.runIds, body.metric);
      return res.json({ _version: 1, metric: body.metric, comparison: out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountExperimentTrackingRoutes;
