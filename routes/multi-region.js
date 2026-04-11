/**
 * Phase 40.1: Multi-region replication routes.
 *
 * Endpoints:
 *   GET    /api/v1/regions                       - list regions with health
 *   POST   /api/v1/regions                       - register region (admin)
 *   GET    /api/v1/regions/replication-queue     - queue status
 *   GET    /api/v1/regions/:id/lag               - replication lag for region
 *   POST   /api/v1/regions/:id/catch-up          - drain queue toward region
 *   POST   /api/v1/regions/failover              - manual failover (admin)
 */
import {
  registerRegion,
  getRegions,
  getPrimaryRegion,
  getHealthyRegions,
  getReplicationLag,
  catchUpRegion,
  failoverToRegion,
  checkAllRegions,
} from "../lib/multi-region.js";
import { getQueueSize, peekQueue } from "../lib/replication-queue.js";

export function mountMultiRegionRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    adminAuth,
    userAuth,
    requireScope,
    logRequest,
    storageRateLimiter,
  } = deps;

  // GET /api/v1/regions — public list (any authenticated user can read)
  apiRoute("get", "/regions", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const regions = await getRegions();
      const primary = await getPrimaryRegion();
      const healthy = await getHealthyRegions();
      res.json({
        ok: true,
        regions,
        primary: primary?.regionId || null,
        healthyCount: healthy.length,
        total: regions.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/regions — register a new region (admin only)
  apiRoute("post", "/regions", storageRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { regionId, url, primary, readOnly, lag } = req.body || {};
      if (!regionId) return apiError(res, 400, "BAD_REQUEST", "regionId is required");
      if (!url) return apiError(res, 400, "BAD_REQUEST", "url is required");
      const region = await registerRegion(regionId, { url, primary, readOnly, lag });
      res.status(201).json({ ok: true, region });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  // GET /api/v1/regions/replication-queue — queue status (admin)
  apiRoute("get", "/regions/replication-queue", storageRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const size = await getQueueSize();
      const limit = Math.min(parseInt(req.query?.limit, 10) || 50, 500);
      const ops = await peekQueue(limit);
      res.json({ ok: true, size, ops });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/regions/:id/lag — replication lag
  apiRoute("get", "/regions/:id/lag", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const lag = await getReplicationLag(req.params.id);
      res.json({ ok: true, ...lag });
    } catch (err) {
      if (err.message?.startsWith("Unknown region")) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/regions/:id/catch-up — drain queue (admin)
  apiRoute("post", "/regions/:id/catch-up", storageRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const result = await catchUpRegion(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message?.startsWith("Unknown region")) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/regions/failover — manual failover (admin, requires confirmation)
  apiRoute("post", "/regions/failover", storageRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { regionId, confirm } = req.body || {};
      if (!regionId) return apiError(res, 400, "BAD_REQUEST", "regionId is required");
      if (confirm !== true && confirm !== "true") {
        return apiError(
          res,
          400,
          "CONFIRMATION_REQUIRED",
          "Failover requires explicit confirmation",
          'Pass {"regionId": "...", "confirm": true} in the request body.'
        );
      }
      const result = await failoverToRegion(regionId);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message?.startsWith("Unknown region")) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (err.message?.includes("Cannot failover")) {
        return apiError(res, 409, "CONFLICT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/regions/check — admin trigger for an immediate health sweep
  apiRoute("post", "/regions/check", storageRateLimiter, adminAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const regions = await checkAllRegions();
      res.json({ ok: true, regions });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountMultiRegionRoutes;
