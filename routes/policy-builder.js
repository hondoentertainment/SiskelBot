/**
 * Visual policy builder.
 * GET  /api/v1/workspaces/:id/agent-policy
 * PUT  /api/v1/workspaces/:id/agent-policy
 * GET  /api/v1/workspaces/:id/agent-policy/audit
 */
import { saveWorkspacePolicy, listPolicyEdits, canEditWorkspacePolicy } from "../lib/policy-builder.js";
import { loadWorkspaceAgentSettings, getWorkspaceAgentAccess } from "../lib/workspace-agent-settings.js";
import { sanitizeWorkspace } from "../lib/storage.js";
import { resolveStorageUserId } from "../lib/teams.js";

export function mountPolicyBuilderRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, logRequest } = deps;
  const auth = userAuth || ((_req, _res, next) => next());
  const log = logRequest || ((_req, _res, next) => next());

  apiRoute("get", "/workspaces/:id/agent-policy", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const gate = await getWorkspaceAgentAccess(req.userId || "anonymous", workspaceId);
      if (!gate.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspaceId);
      const settings = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
      res.json({
        workspaceId,
        canEdit: canEditWorkspacePolicy(gate.role),
        agentPolicy: settings.agentPolicy,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/workspaces/:id/agent-policy", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const gate = await getWorkspaceAgentAccess(req.userId || "anonymous", workspaceId);
      if (!gate.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      if (!canEditWorkspacePolicy(gate.role)) {
        return apiError(res, 403, "FORBIDDEN", "Workspace admin role required");
      }
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspaceId);
      const agentPolicy = await saveWorkspacePolicy({
        storageUserId,
        workspaceId,
        userId: req.userId || "anonymous",
        draft: req.body || {},
      });
      res.json({ workspaceId, agentPolicy });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/workspaces/:id/agent-policy/audit", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const gate = await getWorkspaceAgentAccess(req.userId || "anonymous", workspaceId);
      if (!gate.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      const edits = await listPolicyEdits(workspaceId);
      res.json({ workspaceId, edits });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
