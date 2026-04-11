/**
 * Phase 53.5: Schema validation + repair routes.
 *
 * POST /api/v1/schema-repair/validate  -- body { schema, args }
 * POST /api/v1/schema-repair/repair    -- body { schema, args, toolName? }
 * POST /api/v1/schema-repair/diff      -- body { before, after }
 * POST /api/v1/schema-repair/suggest   -- body { schema, args }
 * GET  /api/v1/schema-repair/stats/:toolName?
 */
import {
  validateArgs,
  repairArgs,
  diffArgs,
  suggestFixes,
  recordRepairEvent,
  getRepairStats,
} from "../lib/schema-repair.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "schema-repair error");
}

export function mountSchemaRepairRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/schema-repair/validate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema) {
        return apiError(res, 400, "INVALID_INPUT", "schema is required");
      }
      const result = validateArgs(body.schema, body.args);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/schema-repair/repair", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema) {
        return apiError(res, 400, "INVALID_INPUT", "schema is required");
      }
      const result = repairArgs(body.schema, body.args);
      if (typeof body.toolName === "string" && body.toolName) {
        try {
          await recordRepairEvent(body.toolName, {
            repaired: result.repairs.length,
            errors: result.remainingErrors.length,
          });
        } catch (_) { /* non-fatal */ }
      }
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/schema-repair/diff", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const diffs = diffArgs(body.before, body.after);
      return res.json({ _version: 1, diffs });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/schema-repair/suggest", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema) {
        return apiError(res, 400, "INVALID_INPUT", "schema is required");
      }
      const hints = suggestFixes(body.schema, body.args);
      return res.json({ _version: 1, hints });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/schema-repair/stats/:toolName?", log, auth, scope("read"), async (req, res) => {
    try {
      const stats = await getRepairStats(req.params.toolName);
      return res.json({ _version: 1, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountSchemaRepairRoutes;
