/**
 * Phase 35.4: Query performance analyzer admin routes.
 *
 *   GET  /api/v1/admin/queries/slow                     — recent slow queries
 *   GET  /api/v1/admin/queries/top                      — top aggregated queries
 *   GET  /api/v1/admin/queries/indexes/suggestions      — suggested indexes
 *   GET  /api/v1/admin/queries/tables/stats             — pg_stat_user_tables
 *   POST /api/v1/admin/queries/analyze                  — run EXPLAIN ANALYZE
 *   GET  /api/v1/admin/queries/:fingerprint             — single query stats
 *
 * All routes are protected by `adminAuth` + `requireScope('admin')`.
 */
import { globalQueryAnalyzer } from "../lib/query-analyzer.js";
import { getPostgresPool, postgresKvEnabled } from "../lib/storage-postgres-kv.js";

export function mountQueryAnalyzerRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, requireScope, logRequest } = deps;

  async function resolvePool(res) {
    if (!postgresKvEnabled()) {
      apiError(
        res,
        503,
        "POSTGRES_NOT_ENABLED",
        "PostgreSQL backend is not enabled.",
        "Set STORAGE_BACKEND=postgres and DATABASE_URL to use query analyzer pool features."
      );
      return null;
    }
    const pool = await getPostgresPool();
    if (!pool) {
      apiError(res, 503, "POSTGRES_UNAVAILABLE", "Could not connect to PostgreSQL.");
      return null;
    }
    return pool;
  }

  // GET /api/v1/admin/queries/slow?limit=50
  apiRoute(
    "get",
    "/admin/queries/slow",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const limit = Number(req.query?.limit) || 50;
        const queries = globalQueryAnalyzer.getSlowQueries(limit);
        res.json({
          threshold: Number(process.env.SLOW_QUERY_THRESHOLD_MS) || 100,
          count: queries.length,
          queries,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/admin/queries/top?sortBy=total_time&limit=20
  apiRoute(
    "get",
    "/admin/queries/top",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const sortBy = String(req.query?.sortBy || "total_time");
        const allowed = ["count", "total_time", "avg_time", "max_time"];
        if (!allowed.includes(sortBy)) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            `sortBy must be one of: ${allowed.join(", ")}`
          );
        }
        const limit = Number(req.query?.limit) || 20;
        const queries = globalQueryAnalyzer.getTopQueries(sortBy, limit);
        res.json({ sortBy, count: queries.length, queries });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/admin/queries/indexes/suggestions
  apiRoute(
    "get",
    "/admin/queries/indexes/suggestions",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        // Pool is optional — suggestIndexes works without it but cannot
        // deduplicate against existing indexes.
        let pool = null;
        if (postgresKvEnabled()) {
          try {
            pool = await getPostgresPool();
          } catch {
            pool = null;
          }
        }
        const suggestions = await globalQueryAnalyzer.suggestIndexes(pool);
        res.json({ count: suggestions.length, suggestions });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/admin/queries/tables/stats
  apiRoute(
    "get",
    "/admin/queries/tables/stats",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const pool = await resolvePool(res);
        if (!pool) return;
        const tables = await globalQueryAnalyzer.getTableStats(pool);
        res.json({ count: tables.length, tables });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // POST /api/v1/admin/queries/analyze  { query, params? }
  apiRoute(
    "post",
    "/admin/queries/analyze",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const { query, params } = req.body || {};
        if (!query || typeof query !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "query string is required");
        }
        const pool = await resolvePool(res);
        if (!pool) return;
        try {
          const result = await globalQueryAnalyzer.analyzeQuery(
            pool,
            query,
            Array.isArray(params) ? params : undefined
          );
          res.json(result);
        } catch (err) {
          return apiError(res, 400, "ANALYZE_FAILED", err.message);
        }
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  // GET /api/v1/admin/queries/:fingerprint
  // Note: must be registered AFTER the more specific routes above so
  // `/slow`, `/top`, `/analyze`, etc. aren't captured by this param.
  apiRoute(
    "get",
    "/admin/queries/:fingerprint",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        // Fingerprints are normalized SQL (may contain spaces/punct); the
        // client is expected to URL-encode the value before passing it.
        const fingerprint = decodeURIComponent(String(req.params.fingerprint || ""));
        const stats = globalQueryAnalyzer.getQueryStats(fingerprint);
        if (!stats) {
          return apiError(res, 404, "NOT_FOUND", "No stats for that fingerprint");
        }
        res.json(stats);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );
}

export default mountQueryAnalyzerRoutes;
