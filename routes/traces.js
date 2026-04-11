/**
 * Phase 31.1: In-process trace explorer HTTP API.
 *
 * Exposes the shared `globalTraceExplorer` (see `lib/trace-explorer.js`) over
 * HTTP so the client page at `/traces.html` (and curl users) can visualize
 * OpenTelemetry spans captured in-process.
 *
 * Endpoints (mounted under both `/api/` and `/api/v1/`):
 *   GET /traces/explorer                  - list recent traces with filters
 *   GET /traces/explorer/stats            - aggregate counters
 *   GET /traces/explorer/:traceId         - flat span list for one trace
 *   GET /traces/explorer/:traceId/tree    - tree/waterfall structure for one trace
 */
import { globalTraceExplorer } from "../lib/trace-explorer.js";

export function mountTraceExplorerRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, isAuthConfigured } = deps;

  const handlers = [logRequest];
  if (typeof isAuthConfigured === "function" && isAuthConfigured() && userAuth) {
    handlers.push(userAuth);
  }

  // --- List recent traces ---
  apiRoute("get", "/traces/explorer", ...handlers, (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
      const filter = { limit };
      if (req.query.service) filter.service = String(req.query.service);
      if (req.query.status) filter.status = String(req.query.status);
      if (req.query.name) filter.name = String(req.query.name);
      if (req.query.minDuration != null && req.query.minDuration !== "") {
        const md = Number(req.query.minDuration);
        if (Number.isFinite(md)) filter.minDuration = md;
      }
      if (req.query.startTime != null && req.query.startTime !== "") {
        const st = Number(req.query.startTime);
        if (Number.isFinite(st)) filter.startTime = st;
      }

      const traces = globalTraceExplorer.listTraces(filter);
      res.json({
        enabled: process.env.TRACE_EXPLORER === "1",
        count: traces.length,
        traces,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // --- Aggregate stats ---
  apiRoute("get", "/traces/explorer/stats", ...handlers, (_req, res) => {
    try {
      const stats = globalTraceExplorer.getStats();
      res.json({
        enabled: process.env.TRACE_EXPLORER === "1",
        ...stats,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // --- Single trace (tree view) ---
  apiRoute("get", "/traces/explorer/:traceId/tree", ...handlers, (req, res) => {
    try {
      const traceId = String(req.params.traceId || "").trim();
      if (!traceId) {
        return apiError(res, 400, "INVALID_TRACE_ID", "traceId is required");
      }
      const tree = globalTraceExplorer.getTraceTree(traceId);
      if (!tree) {
        return apiError(
          res,
          404,
          "TRACE_NOT_FOUND",
          "Trace not found in in-memory explorer",
          "Traces are buffered in-process and bounded; enable TRACE_EXPLORER=1 and reproduce the request."
        );
      }
      res.json(tree);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // --- Single trace (flat list) ---
  apiRoute("get", "/traces/explorer/:traceId", ...handlers, (req, res) => {
    try {
      const traceId = String(req.params.traceId || "").trim();
      if (!traceId) {
        return apiError(res, 400, "INVALID_TRACE_ID", "traceId is required");
      }
      const spans = globalTraceExplorer.getTrace(traceId);
      if (!spans) {
        return apiError(
          res,
          404,
          "TRACE_NOT_FOUND",
          "Trace not found in in-memory explorer",
          "Traces are buffered in-process and bounded; enable TRACE_EXPLORER=1 and reproduce the request."
        );
      }
      res.json({ traceId, spanCount: spans.length, spans });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountTraceExplorerRoutes;
