/**
 * Phase 57.3: Schema evolution routes.
 *
 * POST   /api/v1/schema-evolution/subjects/:subject                — register a new version
 * GET    /api/v1/schema-evolution/subjects                         — list subjects
 * GET    /api/v1/schema-evolution/subjects/:subject                — get latest version
 * GET    /api/v1/schema-evolution/subjects/:subject/versions       — list versions
 * GET    /api/v1/schema-evolution/subjects/:subject/versions/:v    — get a specific version
 * POST   /api/v1/schema-evolution/subjects/:subject/compatibility  — change mode
 * POST   /api/v1/schema-evolution/check                            — dry-run compatibility check
 */
import {
  COMPATIBILITY_MODES,
  registerSchema,
  getSchema,
  listVersions,
  listSubjects,
  setCompatibility,
  checkCompatibility,
} from "../lib/schema-evolution.js";

function mapErr(err) {
  if (err?.code === "INCOMPATIBLE") return { status: 409, code: "INCOMPATIBLE" };
  if (err?.code === "NOT_FOUND" || /not found/i.test(err?.message || "")) return { status: 404, code: "NOT_FOUND" };
  if (/required|must be/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountSchemaEvolutionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/schema-evolution/modes", adminAuth, logRequest, async (req, res) => {
    res.json({ modes: COMPATIBILITY_MODES });
  });

  apiRoute("get", "/schema-evolution/subjects", adminAuth, logRequest, async (req, res) => {
    res.json({ subjects: await listSubjects() });
  });

  apiRoute("post", "/schema-evolution/subjects/:subject", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema) return apiError(res, 400, "INVALID_INPUT", "schema is required");
      const result = await registerSchema(req.params.subject, body.schema, {
        compatibility: body.compatibility,
      });
      res.status(201).json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/schema-evolution/subjects/:subject", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getSchema(req.params.subject);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "subject not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/schema-evolution/subjects/:subject/versions", adminAuth, logRequest, async (req, res) => {
    res.json({ versions: await listVersions(req.params.subject) });
  });

  apiRoute("get", "/schema-evolution/subjects/:subject/versions/:version", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getSchema(req.params.subject, req.params.version);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "version not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/schema-evolution/subjects/:subject/compatibility", adminAuth, logRequest, async (req, res) => {
    try {
      const mode = req.body?.mode;
      const result = await setCompatibility(req.params.subject, mode);
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/schema-evolution/check", adminAuth, logRequest, async (req, res) => {
    try {
      const { oldSchema, newSchema, mode } = req.body || {};
      if (!oldSchema || !newSchema) {
        return apiError(res, 400, "INVALID_INPUT", "oldSchema and newSchema are required");
      }
      const result = checkCompatibility(oldSchema, newSchema, mode || "backward");
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}

export default mountSchemaEvolutionRoutes;
