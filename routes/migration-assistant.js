/**
 * Phase 63.5: Migration assistant routes.
 */
import {
  listCodemods,
  applyCodemod,
  previewCodemod,
  getMigrationPlan,
  runMigration,
  listMigrations,
} from "../lib/migration-assistant.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "migration-assistant error");
}

export function mountMigrationAssistantRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("get", "/code/migration/codemods", log, auth, scope("read"), async (_req, res) => {
    try {
      const mods = await listCodemods();
      return res.json({ _version: 1, codemods: mods, count: mods.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/code/migration/apply", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.id) return apiError(res, 400, "INVALID_INPUT", "id required");
      if (typeof body.text !== "string") return apiError(res, 400, "INVALID_INPUT", "text required");
      const out = await applyCodemod(body.id, body.text);
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/code/migration/preview", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.id) return apiError(res, 400, "INVALID_INPUT", "id required");
      if (!body.files || typeof body.files !== "object") return apiError(res, 400, "INVALID_INPUT", "files required");
      const out = await previewCodemod(body.id, body.files);
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/code/migration/plan", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.codemodIds)) return apiError(res, 400, "INVALID_INPUT", "codemodIds array required");
      if (!body.files || typeof body.files !== "object") return apiError(res, 400, "INVALID_INPUT", "files required");
      const plan = await getMigrationPlan(body.codemodIds, body.files);
      return res.json({ _version: 1, ...plan });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/code/migration/run", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.codemodIds)) return apiError(res, 400, "INVALID_INPUT", "codemodIds array required");
      if (!body.files || typeof body.files !== "object") return apiError(res, 400, "INVALID_INPUT", "files required");
      const out = await runMigration(body.codemodIds, body.files);
      return res.status(201).json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/code/migration/runs", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listMigrations();
      return res.json({ _version: 1, migrations: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountMigrationAssistantRoutes;
