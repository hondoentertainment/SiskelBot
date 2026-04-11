/**
 * Phase 57.3: Schema evolution routes.
 *
 * POST /api/v1/schemas                         -- register a schema version
 * GET  /api/v1/schemas                         -- list schemas
 * GET  /api/v1/schemas/:name                   -- latest (or specific) version
 * POST /api/v1/schemas/:name/migrate           -- migrate a record
 * GET  /api/v1/schemas/:name/diff              -- diff two versions
 */
import {
  registerSchema,
  getSchemaVersion,
  migrateRecord,
  listSchemas,
  diffSchemas,
  latestVersion,
} from "../lib/schema-evolution.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "schema-evolution error");
}

export function mountSchemaEvolutionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/schemas", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || !Number.isFinite(body.version) || !body.schema) {
        return apiError(res, 400, "INVALID_INPUT", "name, version, schema required");
      }
      const s = await registerSchema(body.name, body.version, body.schema);
      return res.status(201).json({ _version: 1, schema: s });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/schemas", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listSchemas();
      return res.json({ _version: 1, schemas: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/schemas/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const v = req.query.version != null ? Number(req.query.version) : undefined;
      const schema = await getSchemaVersion(req.params.name, v);
      if (!schema) return apiError(res, 404, "NOT_FOUND", `schema "${req.params.name}" not found`);
      const latest = await latestVersion(req.params.name);
      return res.json({ _version: 1, schema, latest });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/schemas/:name/migrate", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.record || typeof body.record !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "record required");
      }
      const out = await migrateRecord(req.params.name, body.record);
      return res.json({ _version: 1, record: out });
    } catch (err) {
      const status = /no schema|unknown source/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/schemas/:name/diff", log, auth, scope("read"), async (req, res) => {
    try {
      const v1 = Number(req.query.from);
      const v2 = Number(req.query.to);
      if (!Number.isFinite(v1) || !Number.isFinite(v2)) {
        return apiError(res, 400, "INVALID_INPUT", "from and to query params required");
      }
      const diff = await diffSchemas(req.params.name, v1, v2);
      return res.json({ _version: 1, diff });
    } catch (err) {
      const status = /no schema|no version/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });
}

export default mountSchemaEvolutionRoutes;
