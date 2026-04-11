/**
 * Phase 60.3: Step latency routes.
 *
 * POST /api/v1/step-latency/record    -- body { cortex, tool, durationMs, traceId?, status? }
 * POST /api/v1/step-latency/breakdown -- body { groupBy?, filter? }
 * POST /api/v1/step-latency/percentiles -- body { groupBy?, filter? }
 * POST /api/v1/step-latency/traces    -- body { limit?, filter? }
 * DELETE /api/v1/step-latency         -- admin only
 */
import {
  recordStep,
  getBreakdown,
  getPercentiles,
  listTraces,
  clearStats,
} from "../lib/step-latency.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "step-latency error");
}

export function mountStepLatencyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/step-latency/record", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const step = await recordStep(body);
      return res.status(201).json({ _version: 1, step });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/step-latency/breakdown", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await getBreakdown({
        groupBy: typeof body.groupBy === "string" ? body.groupBy : undefined,
        filter: body.filter && typeof body.filter === "object" ? body.filter : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/step-latency/percentiles", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await getPercentiles({
        groupBy: typeof body.groupBy === "string" ? body.groupBy : undefined,
        filter: body.filter && typeof body.filter === "object" ? body.filter : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/step-latency/traces", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await listTraces({
        limit: Number.isFinite(body.limit) ? body.limit : undefined,
        filter: body.filter && typeof body.filter === "object" ? body.filter : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/step-latency", log, admin, async (_req, res) => {
    try {
      const result = await clearStats();
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountStepLatencyRoutes;
