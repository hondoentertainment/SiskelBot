/**
 * Phase 60.4: Log analysis routes.
 *
 * POST /api/v1/log-analysis/ingest   -- body { message, level?, source?, timestamp? }
 * POST /api/v1/log-analysis/detect   -- body { windowMs?, baselineWindows?, spikeFactor? }
 * POST /api/v1/log-analysis/cluster  -- body { top? }
 * POST /api/v1/log-analysis/summary  -- body { windowMs? }
 * GET  /api/v1/log-analysis/anomalies
 * DELETE /api/v1/log-analysis        -- admin only
 */
import {
  ingestLog,
  detectAnomalies,
  clusterErrors,
  summarizeWindow,
  listAnomalies,
  clearLogs,
} from "../lib/log-analysis.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "log-analysis error");
}

export function mountLogAnalysisRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/log-analysis/ingest", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const entry = await ingestLog(body);
      return res.status(201).json({ _version: 1, entry });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/log-analysis/detect", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await detectAnomalies({
        windowMs: Number.isFinite(body.windowMs) ? body.windowMs : undefined,
        baselineWindows: Number.isFinite(body.baselineWindows) ? body.baselineWindows : undefined,
        spikeFactor: Number.isFinite(body.spikeFactor) ? body.spikeFactor : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/log-analysis/cluster", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await clusterErrors({
        top: Number.isFinite(body.top) ? body.top : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/log-analysis/summary", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await summarizeWindow({
        windowMs: Number.isFinite(body.windowMs) ? body.windowMs : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/log-analysis/anomalies", log, auth, scope("read"), async (_req, res) => {
    try {
      const anomalies = await listAnomalies();
      return res.json({ _version: 1, anomalies, count: anomalies.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/log-analysis", log, admin, async (_req, res) => {
    try {
      const result = await clearLogs();
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountLogAnalysisRoutes;
