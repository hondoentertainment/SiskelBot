/**
 * Route module: step-level latency rollup (Phase 60.3).
 *
 * GET    /api/v1/step-latency/report                     — full per-(cortex,tool) report
 * GET    /api/v1/step-latency/by-cortex                  — aggregated by cortex
 * GET    /api/v1/step-latency/by-tool                    — aggregated by tool
 * POST   /api/v1/step-latency/record                     — manually record a step (test hook)
 * POST   /api/v1/step-latency/persist                    — flush rollup to disk
 * POST   /api/v1/step-latency/reset                      — clear rollup (admin)
 *
 * All routes require an admin-scoped API key.
 */

import {
  recordStep,
  getLatencyReport,
  getBreakdownByCortex,
  getBreakdownByTool,
  persistRollup,
  resetLatency,
} from "../lib/step-latency.js";

export function mountStepLatencyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // GET /api/v1/step-latency/report
  apiRoute("get", "/step-latency/report", adminAuth, logRequest, async (req, res) => {
    try {
      res.json(getLatencyReport());
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/step-latency/by-cortex
  apiRoute("get", "/step-latency/by-cortex", adminAuth, logRequest, async (req, res) => {
    try {
      res.json(getBreakdownByCortex());
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/step-latency/by-tool
  apiRoute("get", "/step-latency/by-tool", adminAuth, logRequest, async (req, res) => {
    try {
      res.json(getBreakdownByTool());
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/step-latency/record
  apiRoute("post", "/step-latency/record", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = recordStep({
        cortex: body.cortex,
        tool: body.tool,
        latencyMs: body.latencyMs,
        ok: body.ok,
        at: body.at,
      });
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/step-latency/persist
  apiRoute("post", "/step-latency/persist", adminAuth, logRequest, async (req, res) => {
    try {
      const report = await persistRollup();
      res.json({ persisted: true, totalKeys: report.totalKeys });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/step-latency/reset
  apiRoute("post", "/step-latency/reset", adminAuth, logRequest, async (req, res) => {
    try {
      resetLatency();
      res.json({ reset: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountStepLatencyRoutes;
