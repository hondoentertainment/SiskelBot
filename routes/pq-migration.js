/**
 * Phase 50.5: Post-quantum migration routes. Admin-only.
 *
 * GET    /api/v1/pq/migration/status           — current migration status summary
 * POST   /api/v1/pq/migration/scan             — scan classical key inventory
 * POST   /api/v1/pq/migration/plan             — generate a migration plan
 * POST   /api/v1/pq/migration/rotate/:keyId    — rotate a specific key
 * POST   /api/v1/pq/migration/rollback/:keyId  — rollback a rotation
 * GET    /api/v1/pq/migration/report           — full migration report
 * GET    /api/v1/pq/migration/readiness        — check PQ module readiness
 */
import {
  scanClassicalKeys,
  planMigration,
  rotateKey,
  rollbackRotation,
  getMigrationStatus,
  generateMigrationReport,
  validatePqReadiness,
} from "../lib/pq-migration.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must be|invalid|not rotatable|no pq equivalent|no active rotation/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "pq-migration error");
}

export function mountPqMigrationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof adminAuth === "function" ? adminAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/pq/migration/status
  apiRoute("get", "/pq/migration/status", log, auth, scope("admin"), async (_req, res) => {
    try {
      const status = await getMigrationStatus();
      return res.json({ _version: 1, status });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/pq/migration/scan
  apiRoute("post", "/pq/migration/scan", log, auth, scope("admin"), async (req, res) => {
    try {
      const body = req.body || {};
      const options = {
        includeHsm: body.includeHsm !== false,
        includeJwt: body.includeJwt !== false,
        includeTls: body.includeTls !== false,
      };
      const keys = await scanClassicalKeys(options);
      return res.json({ _version: 1, keys, count: keys.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/pq/migration/plan
  apiRoute("post", "/pq/migration/plan", log, auth, scope("admin"), async (req, res) => {
    try {
      const body = req.body || {};
      const targetLevel = body.targetLevel || "ml-dsa-65";
      // If the client does not pass keys, scan them first.
      let keys = Array.isArray(body.keys) ? body.keys : null;
      if (!keys) {
        keys = await scanClassicalKeys();
      }
      const plan = await planMigration(keys, targetLevel);
      return res.json({ _version: 1, plan, count: plan.length, targetLevel });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/pq/migration/rotate/:keyId
  apiRoute("post", "/pq/migration/rotate/:keyId", log, auth, scope("admin"), async (req, res) => {
    try {
      const { keyId } = req.params;
      const body = req.body || {};
      const result = await rotateKey(keyId, {
        targetLevel: body.targetLevel || "ml-dsa-65",
        actor: body.actor || req.user?.id || "admin",
      });
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/pq/migration/rollback/:keyId
  apiRoute("post", "/pq/migration/rollback/:keyId", log, auth, scope("admin"), async (req, res) => {
    try {
      const { keyId } = req.params;
      const result = await rollbackRotation(keyId);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/pq/migration/report
  apiRoute("get", "/pq/migration/report", log, auth, scope("admin"), async (_req, res) => {
    try {
      const report = await generateMigrationReport();
      return res.json({ _version: 1, report });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/pq/migration/readiness
  apiRoute("get", "/pq/migration/readiness", log, auth, scope("admin"), async (_req, res) => {
    try {
      const readiness = await validatePqReadiness();
      return res.json({ _version: 1, readiness });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountPqMigrationRoutes;
