/**
 * Phase 39.3: Anomaly Detection routes.
 *
 *   GET  /api/v1/analytics/anomalies                   — list active anomalies
 *   GET  /api/v1/analytics/anomalies/history?days=30   — historical anomalies
 *   POST /api/v1/analytics/anomalies/:id/acknowledge   — acknowledge an anomaly
 *   POST /api/v1/analytics/anomalies/scan              — manual scan (admin)
 */
import rateLimit from "express-rate-limit";
import {
  getActiveAnomalies,
  getAnomalyHistory,
  acknowledgeAnomaly,
  runFullScan,
  runAnomalyScan,
  MONITORED_METRICS,
} from "../lib/anomaly-detection.js";

export function mountAnomalyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, isAuthConfigured, adminAuth } = deps;

  const anomalyRateLimiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const handlers = [anomalyRateLimiter, logRequest];
  if (typeof isAuthConfigured === "function" && isAuthConfigured()) handlers.push(userAuth);

  // GET /api/v1/analytics/anomalies — list active anomalies
  apiRoute("get", "/analytics/anomalies", ...handlers, async (req, res) => {
    try {
      const workspace = req.query.workspace || req.headers["x-workspace-id"] || undefined;
      const anomalies = await getActiveAnomalies(workspace);
      res.json({ ok: true, anomalies, count: anomalies.length });
    } catch (err) {
      console.error("Anomaly list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/analytics/anomalies/history?days=30
  apiRoute("get", "/analytics/anomalies/history", ...handlers, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      const workspace = req.query.workspace || req.headers["x-workspace-id"] || undefined;
      const history = await getAnomalyHistory(days, workspace);
      res.json({ ok: true, days, anomalies: history, count: history.length });
    } catch (err) {
      console.error("Anomaly history error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/analytics/anomalies/:id/acknowledge
  apiRoute("post", "/analytics/anomalies/:id/acknowledge", ...handlers, async (req, res) => {
    try {
      const id = req.params.id;
      if (!id) return apiError(res, 400, "INVALID_INPUT", "anomaly id is required");
      const updated = await acknowledgeAnomaly(id);
      if (!updated) return apiError(res, 404, "NOT_FOUND", "anomaly not found");
      res.json({ ok: true, anomaly: updated });
    } catch (err) {
      console.error("Anomaly ack error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/analytics/anomalies/scan — admin only
  const scanHandlers = [anomalyRateLimiter, logRequest];
  if (typeof adminAuth === "function") scanHandlers.push(adminAuth);
  apiRoute("post", "/analytics/anomalies/scan", ...scanHandlers, async (req, res) => {
    try {
      const body = req.body || {};
      const opts = {
        workspace: body.workspace || req.query.workspace || undefined,
        period: body.period || req.query.period || 7,
        method: body.method || req.query.method || "zscore",
      };
      let result;
      if (body.metric) {
        if (!MONITORED_METRICS.includes(body.metric)) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            `metric must be one of: ${MONITORED_METRICS.join(", ")}`,
          );
        }
        const single = await runAnomalyScan(body.metric, opts.period, {
          workspace: opts.workspace,
          method: opts.method,
        });
        result = { scanned: 1, total: single.anomalies.length, anomalies: single.anomalies };
      } else {
        result = await runFullScan(opts);
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error("Anomaly scan error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountAnomalyRoutes;
