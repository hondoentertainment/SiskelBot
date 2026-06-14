/**
 * Phase 61.5: Schema registry routes.
 *
 * POST /api/v1/schemas                                        — register new schema version
 * GET  /api/v1/schemas/:namespace/:id                         — list versions
 * GET  /api/v1/schemas/:namespace/:id/:version                — get specific version
 * POST /api/v1/schemas/:namespace/:id/diff                    — diff two schemas (ids/versions in body)
 */
import {
  registerSchema,
  getSchema,
  listVersions,
  diffSchemas,
} from "../lib/schema-registry.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (err?.code === "ALREADY_EXISTS") return { status: 409, code: "ALREADY_EXISTS" };
  if (/required|must be/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountSchemaRegistryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /schemas
  apiRoute("post", "/schemas", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await registerSchema({
        namespace: body.namespace,
        id: body.id,
        version: body.version,
        schema: body.schema,
        description: body.description,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /schemas/:namespace/:id
  apiRoute("get", "/schemas/:namespace/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const versions = await listVersions(req.params.namespace, req.params.id);
      res.json({ namespace: req.params.namespace, id: req.params.id, versions });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /schemas/:namespace/:id/:version
  apiRoute("get", "/schemas/:namespace/:id/:version", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getSchema(req.params.namespace, req.params.id, req.params.version);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "schema not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /schemas/:namespace/:id/diff
  apiRoute("post", "/schemas/:namespace/:id/diff", adminAuth, logRequest, async (req, res) => {
    try {
      const { fromVersion, toVersion, fromSchema, toSchema } = req.body || {};
      let before = fromSchema;
      let after = toSchema;
      if (!before && fromVersion) {
        const rec = await getSchema(req.params.namespace, req.params.id, fromVersion);
        if (!rec) return apiError(res, 404, "NOT_FOUND", `fromVersion ${fromVersion} not found`);
        before = rec.schema;
      }
      if (!after && toVersion) {
        const rec = await getSchema(req.params.namespace, req.params.id, toVersion);
        if (!rec) return apiError(res, 404, "NOT_FOUND", `toVersion ${toVersion} not found`);
        after = rec.schema;
      }
      if (!before || !after) {
        return apiError(res, 400, "INVALID_INPUT", "fromVersion/fromSchema and toVersion/toSchema are required");
      }
      const diff = diffSchemas(before, after);
      res.json(diff);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountSchemaRegistryRoutes;
