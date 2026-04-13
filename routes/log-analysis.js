/**
 * Route module: log analysis (Phase 60.4).
 *
 * POST   /api/v1/log-analysis/ingest       — ingest batch of log lines
 * GET    /api/v1/log-analysis/anomalies    — get current anomaly list
 * GET    /api/v1/log-analysis/clusters     — list clusters (digest)
 * GET    /api/v1/log-analysis/summary      — LLM-shaped summary of anomalies
 * POST   /api/v1/log-analysis/persist      — flush state to disk
 * POST   /api/v1/log-analysis/reset        — clear clusters
 *
 * All routes require an admin-scoped API key.
 */

import {
  ingestLogs,
  getAnomalies,
  getClusterSummary,
  summarizeWithLlm,
  persistState,
  resetLogAnalysis,
} from "../lib/log-analysis.js";

export function mountLogAnalysisRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /api/v1/log-analysis/ingest
  apiRoute("post", "/log-analysis/ingest", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const lines = Array.isArray(body.lines) ? body.lines : body.logs;
      if (!Array.isArray(lines)) {
        return apiError(res, 400, "INVALID_INPUT", "lines must be an array");
      }
      const result = ingestLogs(lines);
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /api/v1/log-analysis/anomalies
  apiRoute("get", "/log-analysis/anomalies", adminAuth, logRequest, async (req, res) => {
    try {
      const windowMs = Number(req.query?.windowMs);
      const spikeRatio = Number(req.query?.spikeRatio);
      const newClusterMinCount = Number(req.query?.newClusterMinCount);
      const opts = {};
      if (Number.isFinite(windowMs) && windowMs > 0) opts.windowMs = windowMs;
      if (Number.isFinite(spikeRatio) && spikeRatio > 0) opts.spikeRatio = spikeRatio;
      if (Number.isFinite(newClusterMinCount) && newClusterMinCount > 0) {
        opts.newClusterMinCount = newClusterMinCount;
      }
      res.json(getAnomalies(opts));
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/log-analysis/clusters
  apiRoute("get", "/log-analysis/clusters", adminAuth, logRequest, async (req, res) => {
    try {
      const limit = Number(req.query?.limit);
      res.json(getClusterSummary({ limit: Number.isFinite(limit) ? limit : undefined }));
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/log-analysis/summary
  apiRoute("get", "/log-analysis/summary", adminAuth, logRequest, async (req, res) => {
    try {
      const windowMs = Number(req.query?.windowMs);
      const opts = {};
      if (Number.isFinite(windowMs) && windowMs > 0) opts.windowMs = windowMs;
      const result = await summarizeWithLlm(opts);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/log-analysis/persist
  apiRoute("post", "/log-analysis/persist", adminAuth, logRequest, async (req, res) => {
    try {
      const snapshot = await persistState();
      res.json({ persisted: true, clusters: snapshot.clusters.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/log-analysis/reset
  apiRoute("post", "/log-analysis/reset", adminAuth, logRequest, async (req, res) => {
    try {
      resetLogAnalysis();
      res.json({ reset: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountLogAnalysisRoutes;
