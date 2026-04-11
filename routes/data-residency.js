/**
 * Phase 40.3: Data residency routes.
 *
 *   GET  /api/v1/residency/regions                          — list available regions
 *   GET  /api/v1/workspaces/:id/residency                   — fetch workspace residency
 *   PUT  /api/v1/workspaces/:id/residency                   — set / lock residency
 *   GET  /api/v1/workspaces/:id/residency/report            — compliance report
 *   POST /api/v1/workspaces/:id/residency/migrate           — migrate to a new region (admin)
 */
import {
  RESIDENCY_REGIONS,
  setWorkspaceResidency,
  getWorkspaceResidency,
  generateResidencyReport,
  migrateWorkspaceResidency,
  recordViolation,
  getInstanceRegion,
} from "../lib/data-residency.js";

export function mountDataResidencyRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    storageRateLimiter,
    userAuth,
    adminAuth,
    requireScope,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());
  const scopeRead = requireScope ? requireScope("read") : (req, res, next) => next();
  const scopeWrite = requireScope ? requireScope("write") : (req, res, next) => next();

  // GET /api/v1/residency/regions
  apiRoute("get", "/residency/regions", limiter, logRequest, (req, res) => {
    try {
      const regions = Object.entries(RESIDENCY_REGIONS).map(([id, info]) => ({
        id,
        name: info.name,
        countries: info.countries,
        compliance: info.compliance,
      }));
      res.json({ _version: 1, regions, instanceRegion: getInstanceRegion() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to list residency regions.");
    }
  });

  // GET /api/v1/workspaces/:id/residency
  apiRoute(
    "get",
    "/workspaces/:id/residency",
    limiter,
    userAuth,
    scopeRead,
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = String(req.params.id || "").trim();
        if (!workspaceId) {
          return apiError(res, 400, "INVALID_INPUT", "workspace id required");
        }
        const record = await getWorkspaceResidency(workspaceId);
        if (!record) {
          return res.json({
            _version: 1,
            workspaceId,
            configured: false,
            region: null,
            instanceRegion: getInstanceRegion(),
          });
        }
        res.json({ _version: 1, configured: true, ...record });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to load residency.");
      }
    }
  );

  // PUT /api/v1/workspaces/:id/residency
  apiRoute(
    "put",
    "/workspaces/:id/residency",
    limiter,
    userAuth,
    scopeWrite,
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = String(req.params.id || "").trim();
        if (!workspaceId) {
          return apiError(res, 400, "INVALID_INPUT", "workspace id required");
        }
        const region = req.body?.region;
        if (!region) {
          return apiError(
            res,
            400,
            "INVALID_INPUT",
            "region is required",
            `Send { "region": "us|eu|uk|apac|ca", "lock": true|false }`
          );
        }
        const lock = req.body?.lock === true || req.body?.lockResidency === true;
        const record = await setWorkspaceResidency(workspaceId, region, lock);
        res.json({ _version: 1, ...record });
      } catch (err) {
        if (/locked/i.test(err.message)) {
          return apiError(res, 409, "RESIDENCY_LOCKED", err.message, "Use the migrate endpoint instead.");
        }
        if (/Invalid region/i.test(err.message)) {
          return apiError(res, 400, "INVALID_REGION", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to set residency.");
      }
    }
  );

  // GET /api/v1/workspaces/:id/residency/report
  apiRoute(
    "get",
    "/workspaces/:id/residency/report",
    limiter,
    userAuth,
    scopeRead,
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = String(req.params.id || "").trim();
        if (!workspaceId) {
          return apiError(res, 400, "INVALID_INPUT", "workspace id required");
        }
        const report = await generateResidencyReport(workspaceId);
        res.json({ _version: 1, ...report });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate residency report.");
      }
    }
  );

  // POST /api/v1/workspaces/:id/residency/migrate
  apiRoute(
    "post",
    "/workspaces/:id/residency/migrate",
    limiter,
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = String(req.params.id || "").trim();
        if (!workspaceId) {
          return apiError(res, 400, "INVALID_INPUT", "workspace id required");
        }
        const newRegion = req.body?.region;
        if (!newRegion) {
          return apiError(res, 400, "INVALID_INPUT", "region is required");
        }
        const confirm = req.body?.confirm === true || req.query?.confirm === "true";
        const performedBy = req.user?.id || req.user?.email || "admin";
        const result = await migrateWorkspaceResidency(workspaceId, newRegion, {
          confirm,
          performedBy,
        });
        // Cross-region migrations are sensitive — record an audit entry.
        await recordViolation({
          workspaceId,
          sourceRegion: result?.plan?.fromRegion || null,
          targetRegion: result?.plan?.toRegion || newRegion,
          operation: "migrate",
          reason: confirm ? "admin_migration_executed" : "admin_migration_dry_run",
          allowed: true,
          performedBy,
        });
        res.json({ _version: 1, ...result });
      } catch (err) {
        if (/Invalid region/i.test(err.message)) {
          return apiError(res, 400, "INVALID_REGION", err.message);
        }
        if (/no residency record/i.test(err.message)) {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to migrate residency.");
      }
    }
  );
}

export default mountDataResidencyRoutes;
