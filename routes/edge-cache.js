/**
 * Phase 35.5: Edge cache invalidation routes.
 *
 * POST /api/v1/edge/invalidate   — purge edge cache for one or more paths
 * GET  /api/v1/edge/providers    — list configured edge providers and status
 *
 * Admin-only. Supports two upstream providers selected by env:
 *   EDGE_PROVIDER=cloudflare  — uses CLOUDFLARE_API_TOKEN + CLOUDFLARE_ZONE_ID
 *   EDGE_PROVIDER=fastly      — uses FASTLY_API_TOKEN + FASTLY_SERVICE_ID
 *
 * The handler accepts either:
 *   { paths: ["/config", "/api/v1/recipes"] }
 *   { patterns: ["/api/v1/recipes/*"] }      // surrogate keys / pattern purge
 */

import {
  invalidateEdgeCache,
  listEdgeProviders,
} from "../lib/edge-cache.js";

export function mountEdgeCacheRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth, requireScope } = deps;

  // POST /api/v1/edge/invalidate — purge cache entries
  apiRoute(
    "post",
    "/edge/invalidate",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const paths = Array.isArray(body.paths) ? body.paths.filter((p) => typeof p === "string" && p.length) : [];
        const patterns = Array.isArray(body.patterns) ? body.patterns.filter((p) => typeof p === "string" && p.length) : [];

        if (paths.length === 0 && patterns.length === 0) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "Either 'paths' or 'patterns' must be a non-empty string array.",
            "Send { paths: [\"/config\"] } or { patterns: [\"/api/v1/recipes/*\"] }.",
          );
        }

        const result = await invalidateEdgeCache({ paths, patterns });
        if (!result.ok) {
          return apiError(
            res,
            result.status || 502,
            result.code || "EDGE_PURGE_FAILED",
            result.error || "Edge cache purge failed.",
            "See docs/EDGE_DEPLOYMENT.md for provider configuration.",
          );
        }
        res.json({
          _version: 1,
          ok: true,
          provider: result.provider,
          purged: result.purged,
          patterns: result.patternsPurged,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/EDGE_DEPLOYMENT.md.");
      }
    },
  );

  // GET /api/v1/edge/providers — list configured edge providers
  apiRoute(
    "get",
    "/edge/providers",
    adminAuth,
    requireScope("admin"),
    logRequest,
    (_req, res) => {
      try {
        const providers = listEdgeProviders();
        res.json({ _version: 1, providers });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );
}

export default mountEdgeCacheRoutes;
