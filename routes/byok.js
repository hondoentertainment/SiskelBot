/**
 * Workspace BYOK.
 * GET    /api/v1/workspaces/:id/byok
 * PUT    /api/v1/workspaces/:id/byok   { provider, apiKey }
 * DELETE /api/v1/workspaces/:id/byok/:provider
 */
import {
  listWorkspaceByok,
  setWorkspaceProviderKey,
  deleteWorkspaceProviderKey,
} from "../lib/workspace-byok.js";
import { getWorkspaceAgentAccess, canEditWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { sanitizeWorkspace } from "../lib/storage.js";

export function mountByokRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, logRequest } = deps;
  const auth = userAuth || ((_req, _res, next) => next());
  const log = logRequest || ((_req, _res, next) => next());

  async function access(req, res, workspaceId, write) {
    const gate = await getWorkspaceAgentAccess(req.userId || "anonymous", workspaceId);
    if (!gate.allowed) {
      apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      return null;
    }
    if (write && !canEditWorkspaceAgentSettings(gate.role)) {
      apiError(res, 403, "FORBIDDEN", "Workspace editor role required");
      return null;
    }
    return gate;
  }

  apiRoute("get", "/workspaces/:id/byok", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, false))) return;
      const items = await listWorkspaceByok(workspaceId);
      res.json({ workspaceId, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/workspaces/:id/byok", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, true))) return;
      const saved = await setWorkspaceProviderKey(workspaceId, req.body?.provider, req.body?.apiKey);
      res.status(201).json(saved);
    } catch (err) {
      const status = err.code === "INVALID_INPUT" ? 400 : 500;
      return apiError(res, status, err.code || "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/workspaces/:id/byok/:provider", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, true))) return;
      const result = await deleteWorkspaceProviderKey(workspaceId, req.params.provider);
      if (!result.deleted) return apiError(res, 404, "NOT_FOUND", "Key not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      const status = err.code === "INVALID_INPUT" ? 400 : 500;
      return apiError(res, status, err.code || "INTERNAL_ERROR", err.message);
    }
  });
}
