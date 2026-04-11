/**
 * Phase 66.5: Tenant migration routes.
 *
 * POST   /api/v1/tenant-migrations              -- plan { tenantId, fromRegion, toRegion }
 * GET    /api/v1/tenant-migrations              -- list
 * GET    /api/v1/tenant-migrations/:id          -- status
 * POST   /api/v1/tenant-migrations/:id/execute  -- execute { untilPhase? }
 * POST   /api/v1/tenant-migrations/:id/rollback -- rollback { reason? }
 */
import {
  planMigration,
  executeMigration,
  rollbackMigration,
  getMigrationStatus,
  listMigrations,
} from "../lib/tenant-migration.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "tenant-migration error");
}

function classify(err) {
  const msg = err?.message || "";
  if (msg.includes("not found")) return 404;
  if (msg.includes("already in progress")) return 409;
  if (msg.includes("required") || msg.includes("must") || msg.includes("unknown") || msg.includes("cannot")) return 400;
  return 500;
}

export function mountTenantMigrationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/tenant-migrations", log, admin, async (req, res) => {
    try {
      const m = await planMigration(req.body || {});
      return res.status(201).json({ _version: 1, migration: m });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("get", "/tenant-migrations", log, admin, async (req, res) => {
    try {
      const tenantId = typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const limit = Number(req.query.limit);
      const items = await listMigrations({ tenantId, status, limit: Number.isFinite(limit) ? limit : undefined });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/tenant-migrations/:id", log, admin, async (req, res) => {
    try {
      const m = await getMigrationStatus(req.params.id);
      if (!m) return apiError(res, 404, "NOT_FOUND", `migration ${req.params.id} not found`);
      return res.json({ _version: 1, migration: m });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/tenant-migrations/:id/execute", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const untilPhase = typeof body.untilPhase === "string" ? body.untilPhase : undefined;
      const m = await executeMigration(req.params.id, { untilPhase });
      return res.json({ _version: 1, migration: m });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("post", "/tenant-migrations/:id/rollback", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const m = await rollbackMigration(req.params.id, { reason: body.reason });
      return res.json({ _version: 1, migration: m });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });
}

export default mountTenantMigrationRoutes;
