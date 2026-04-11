/**
 * Phase 60.2: Memory leak routes.
 *
 * POST /api/v1/memleak/snapshot       -- body { label?, records? }
 * GET  /api/v1/memleak/snapshots
 * GET  /api/v1/memleak/snapshots/:id
 * POST /api/v1/memleak/diff           -- body { beforeId, afterId }
 * POST /api/v1/memleak/detect         -- body { windowSize?, minGrowthBytes?, minGrowthRatio? }
 * DELETE /api/v1/memleak/snapshots/:id -- admin only
 * DELETE /api/v1/memleak/snapshots    -- admin only (clear all)
 */
import {
  takeSnapshot,
  diffSnapshots,
  detectLeaks,
  listSnapshots,
  clearSnapshots,
  getSnapshot,
} from "../lib/memory-leak.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "memory-leak error");
}

export function mountMemoryLeakRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/memleak/snapshot", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const snap = await takeSnapshot({
        label: typeof body.label === "string" ? body.label : undefined,
        records: Array.isArray(body.records) ? body.records : undefined,
      });
      return res.status(201).json({ _version: 1, snapshot: snap });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/memleak/snapshots", log, auth, scope("read"), async (_req, res) => {
    try {
      const snaps = await listSnapshots();
      return res.json({ _version: 1, snapshots: snaps, count: snaps.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/memleak/snapshots/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const snap = await getSnapshot(req.params.id);
      if (!snap) {
        return apiError(res, 404, "NOT_FOUND", `snapshot ${req.params.id} not found`);
      }
      return res.json({ _version: 1, snapshot: snap });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/memleak/diff", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.beforeId || !body.afterId) {
        return apiError(res, 400, "INVALID_INPUT", "beforeId and afterId required");
      }
      const diff = await diffSnapshots(body.beforeId, body.afterId);
      return res.json({ _version: 1, diff });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/memleak/detect", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await detectLeaks({
        windowSize: Number.isFinite(body.windowSize) ? body.windowSize : undefined,
        minGrowthBytes: Number.isFinite(body.minGrowthBytes) ? body.minGrowthBytes : undefined,
        minGrowthRatio: Number.isFinite(body.minGrowthRatio) ? body.minGrowthRatio : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/memleak/snapshots/:id", log, admin, async (req, res) => {
    try {
      const result = await clearSnapshots(req.params.id);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/memleak/snapshots", log, admin, async (_req, res) => {
    try {
      const result = await clearSnapshots();
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountMemoryLeakRoutes;
