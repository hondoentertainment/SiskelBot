/**
 * Phase 59.2: Load shedding routes.
 *
 * POST /api/v1/load-shedding/enqueue     -- body { priority, payload }
 * POST /api/v1/load-shedding/dequeue     -- pop one request
 * POST /api/v1/load-shedding/should-shed -- body { priority, depth? }
 * POST /api/v1/load-shedding/capacity    -- body { capacity }
 * GET  /api/v1/load-shedding/stats
 */
import {
  enqueueRequest,
  dequeueRequest,
  shouldShed,
  setCapacity,
  getQueueStats,
} from "../lib/load-shedding.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "load-shedding error");
}

export function mountLoadSheddingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/load-shedding/enqueue
  apiRoute("post", "/load-shedding/enqueue", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await enqueueRequest({
        priority: body.priority,
        payload: body.payload,
      });
      return res.status(result.shed ? 429 : 201).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // POST /api/v1/load-shedding/dequeue
  apiRoute("post", "/load-shedding/dequeue", log, auth, scope("write"), async (_req, res) => {
    try {
      const r = await dequeueRequest();
      if (!r) return apiError(res, 404, "NOT_FOUND", "queue is empty");
      return res.json({ _version: 1, request: r });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/load-shedding/should-shed
  apiRoute("post", "/load-shedding/should-shed", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.priority) {
        return apiError(res, 400, "INVALID_INPUT", "priority is required");
      }
      const depth = Number.isFinite(body.depth) ? Number(body.depth) : undefined;
      const shed = await shouldShed(body.priority, { depth });
      return res.json({ _version: 1, priority: body.priority, shed });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/load-shedding/capacity (admin-only)
  apiRoute("post", "/load-shedding/capacity", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Number.isFinite(body.capacity)) {
        return apiError(res, 400, "INVALID_INPUT", "capacity is required");
      }
      const state = await setCapacity(Number(body.capacity));
      return res.json({ _version: 1, state });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/load-shedding/stats
  apiRoute("get", "/load-shedding/stats", log, auth, scope("read"), async (_req, res) => {
    try {
      const stats = await getQueueStats();
      return res.json({ _version: 1, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountLoadSheddingRoutes;
