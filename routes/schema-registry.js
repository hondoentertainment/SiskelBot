/**
 * Phase 61.5: Schema registry routes.
 *
 * POST /api/v1/schema-registry/register -- body { name, kind?, version?, schema, description? }
 * GET  /api/v1/schema-registry/:name             -- latest
 * GET  /api/v1/schema-registry/:name/:version
 * GET  /api/v1/schema-registry/:name/versions
 * POST /api/v1/schema-registry/:name/compatibility -- body { schema, mode? }
 * POST /api/v1/schema-registry/:name/diff          -- body { from, to }
 */
import {
  registerSchema,
  getSchema,
  listVersions,
  isCompatible,
  diffSchemas,
} from "../lib/schema-registry.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "schema-registry error");
}

export function mountSchemaRegistryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/schema-registry/register", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const schema = await registerSchema(body);
      return res.status(201).json({ _version: 1, schema });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/schema-registry/:name/versions", log, auth, scope("read"), async (req, res) => {
    try {
      const versions = await listVersions(req.params.name);
      return res.json({ _version: 1, name: req.params.name, versions, count: versions.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/schema-registry/:name/:version", log, auth, scope("read"), async (req, res) => {
    try {
      const schema = await getSchema(req.params.name, req.params.version);
      if (!schema) {
        return apiError(res, 404, "NOT_FOUND", `schema ${req.params.name}@${req.params.version} not found`);
      }
      return res.json({ _version: 1, schema });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/schema-registry/:name", log, auth, scope("read"), async (req, res) => {
    try {
      const schema = await getSchema(req.params.name);
      if (!schema) {
        return apiError(res, 404, "NOT_FOUND", `schema ${req.params.name} not found`);
      }
      return res.json({ _version: 1, schema });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/schema-registry/:name/compatibility", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema || typeof body.schema !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "schema is required");
      }
      const result = await isCompatible(
        req.params.name,
        body.schema,
        typeof body.mode === "string" ? body.mode : undefined,
      );
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/schema-registry/:name/diff", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.from || !body.to) {
        return apiError(res, 400, "INVALID_INPUT", "from and to versions required");
      }
      const diff = await diffSchemas(req.params.name, body.from, body.to);
      return res.json({ _version: 1, diff });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });
}

export default mountSchemaRegistryRoutes;
