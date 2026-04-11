/**
 * Phase 40.2: Geo-routing routes.
 *
 * GET  /api/v1/geo/my-region            — return nearest region for the caller
 * GET  /api/v1/geo/regions              — list available regions with distances
 * PUT  /api/v1/user/region-preference   — set the caller's preferred region
 * GET  /api/v1/user/region-preference   — get the caller's preferred region
 * GET  /api/v1/geo/stats                — per-region usage statistics (admin)
 */

import {
  getConfiguredRegions,
  parseClientIP,
  geolocateIP,
  routeToRegion,
  rankRegionsByDistance,
  setUserRegionPreference,
  getUserRegionPreference,
  listUserRegionPreferences,
  getRegionStats,
} from "../lib/geo-routing.js";

export function mountGeoRoutingRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    chatAuth,
    adminAuth,
    requireScope,
  } = deps;

  // GET /api/v1/geo/my-region — resolve nearest region for the caller
  apiRoute("get", "/geo/my-region", logRequest, async (req, res) => {
    try {
      const regions = getConfiguredRegions();
      if (regions.length === 0) {
        return res.json({
          ok: true,
          configured: false,
          regionId: null,
          distance: null,
          url: null,
          ip: parseClientIP(req),
          location: null,
          regions: [],
        });
      }
      const result = await routeToRegion(req, regions);
      res.json({
        ok: true,
        configured: true,
        regionId: result.regionId,
        distance: result.distance,
        url: result.url,
        ip: result.ip,
        location: result.location,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/geo/regions — list regions with distance from the caller
  apiRoute("get", "/geo/regions", logRequest, async (req, res) => {
    try {
      const regions = getConfiguredRegions();
      if (regions.length === 0) {
        return res.json({ ok: true, configured: false, regions: [] });
      }
      const ip = parseClientIP(req);
      const location = ip ? await geolocateIP(ip) : null;
      let ranked;
      if (location && location.latitude != null && location.longitude != null) {
        ranked = rankRegionsByDistance(location.latitude, location.longitude, regions).map((r) => ({
          regionId: r.regionId,
          latitude: r.region.latitude,
          longitude: r.region.longitude,
          url: r.region.url || null,
          distance: r.distance,
        }));
      } else {
        ranked = regions.map((r) => ({
          regionId: r.regionId,
          latitude: r.latitude,
          longitude: r.longitude,
          url: r.url || null,
          distance: null,
        }));
      }
      res.json({
        ok: true,
        configured: true,
        ip,
        location,
        regions: ranked,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/user/region-preference — set the caller's preferred region
  apiRoute("put", "/user/region-preference", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) {
        return apiError(res, 401, "UNAUTHORIZED", "Authentication is required.");
      }
      const body = req.body || {};
      const regionId = body.regionId === null ? null : (typeof body.regionId === "string" ? body.regionId.trim() : "");
      if (regionId !== null && !regionId) {
        return apiError(res, 400, "INVALID_INPUT", "regionId must be a non-empty string or null to clear.");
      }
      if (regionId) {
        const regions = getConfiguredRegions();
        if (regions.length > 0 && !regions.some((r) => r.regionId === regionId)) {
          return apiError(res, 400, "UNKNOWN_REGION", `Unknown regionId: ${regionId}`);
        }
      }
      const result = await setUserRegionPreference(userId, regionId);
      res.json({ ok: true, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/user/region-preference — read the caller's preference
  apiRoute("get", "/user/region-preference", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const userId = req.userId;
      if (!userId) {
        return apiError(res, 401, "UNAUTHORIZED", "Authentication is required.");
      }
      const regionId = await getUserRegionPreference(userId);
      res.json({ ok: true, userId, regionId });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/geo/stats — per-region usage statistics (admin only)
  apiRoute("get", "/geo/stats", adminAuth, requireScope("admin"), logRequest, async (_req, res) => {
    try {
      const stats = await getRegionStats();
      const preferences = await listUserRegionPreferences();
      res.json({ ok: true, stats, preferences });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountGeoRoutingRoutes;
