import { setSecret, listSecrets, deleteSecret } from "../lib/secrets-store.js";

const VALID_SCOPE_TYPES = new Set(["org", "workspace", "session"]);

export function mountSecretsRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, logRequest, isAuthConfigured } = deps;

  const handlers = [logRequest];
  if (isAuthConfigured()) handlers.push(userAuth);

  apiRoute("post", "/secrets", ...handlers, async (req, res) => {
    try {
      const { scopeType, scopeId, name, value, description } = req.body || {};
      if (!scopeType || !VALID_SCOPE_TYPES.has(scopeType)) {
        return apiError(res, 400, "INVALID_INPUT", "scopeType must be org, workspace, or session", null);
      }
      if (!scopeId || typeof scopeId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "scopeId required", null);
      }
      if (!name || typeof name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name required", null);
      }
      if (typeof value !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "value required and must be a string", null);
      }
      const record = await setSecret(scopeType, scopeId, name, value, description || "");
      res.status(201).json(record);
    } catch (err) {
      if (/MAX_SECRETS_PER_SCOPE/.test(err.message)) {
        return apiError(res, 400, "LIMIT_EXCEEDED", err.message, null);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("get", "/secrets", ...handlers, async (req, res) => {
    try {
      const { scopeType, scopeId } = req.query;
      if (!scopeType || !VALID_SCOPE_TYPES.has(scopeType)) {
        return apiError(res, 400, "INVALID_INPUT", "scopeType must be org, workspace, or session", null);
      }
      if (!scopeId || typeof scopeId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "scopeId required", null);
      }
      const items = await listSecrets(scopeType, scopeId);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });

  apiRoute("delete", "/secrets/:name", ...handlers, async (req, res) => {
    try {
      const { scopeType, scopeId } = req.query;
      const name = req.params.name;
      if (!scopeType || !VALID_SCOPE_TYPES.has(scopeType)) {
        return apiError(res, 400, "INVALID_INPUT", "scopeType must be org, workspace, or session", null);
      }
      if (!scopeId || typeof scopeId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "scopeId required", null);
      }
      if (!name) {
        return apiError(res, 400, "INVALID_INPUT", "name param required", null);
      }
      const result = await deleteSecret(scopeType, scopeId, name);
      if (!result.deleted) return apiError(res, 404, "NOT_FOUND", "Secret not found", null);
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, null);
    }
  });
}

export default mountSecretsRoutes;
