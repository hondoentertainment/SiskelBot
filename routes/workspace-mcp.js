/**
 * Workspace MCP attach.
 * GET    /api/v1/workspaces/:id/mcp-servers
 * POST   /api/v1/workspaces/:id/mcp-servers
 * DELETE /api/v1/workspaces/:id/mcp-servers/:serverId
 * POST   /api/v1/workspaces/:id/mcp-servers/:serverId/discover
 */
import {
  listWorkspaceMcpServers,
  registerWorkspaceMcpServer,
  deleteWorkspaceMcpServer,
  discoverWorkspaceMcpTools,
} from "../lib/workspace-mcp.js";
import { getWorkspaceAgentAccess, canEditWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { sanitizeWorkspace } from "../lib/storage.js";

export function mountWorkspaceMcpRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, logRequest } = deps;
  const auth = userAuth || ((_req, _res, next) => next());
  const log = logRequest || ((_req, _res, next) => next());

  async function access(req, res, workspaceId, write) {
    const gate = await getWorkspaceAgentAccess(req.userId || "anonymous", workspaceId);
    if (!gate.allowed) {
      apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied");
      return false;
    }
    if (write && !canEditWorkspaceAgentSettings(gate.role)) {
      apiError(res, 403, "FORBIDDEN", "Workspace editor role required");
      return false;
    }
    return true;
  }

  apiRoute("get", "/workspaces/:id/mcp-servers", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, false))) return;
      res.json({
        workspaceId,
        enabled: process.env.WORKSPACE_MCP_ENABLED === "1",
        stdioEnabled: process.env.WORKSPACE_MCP_STDIO === "1",
        servers: await listWorkspaceMcpServers(workspaceId),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/workspaces/:id/mcp-servers", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, true))) return;
      const server = await registerWorkspaceMcpServer(workspaceId, req.body || {});
      res.status(201).json({ server });
    } catch (err) {
      const status = err.code === "INVALID_INPUT" ? 400 : err.code === "LIMIT_EXCEEDED" ? 400 : 500;
      return apiError(res, status, err.code || "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/workspaces/:id/mcp-servers/:serverId", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, true))) return;
      const removed = await deleteWorkspaceMcpServer(workspaceId, req.params.serverId);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Server not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/workspaces/:id/mcp-servers/:serverId/discover", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, true))) return;
      const tools = await discoverWorkspaceMcpTools(workspaceId, req.params.serverId);
      res.json({ ok: true, tools });
    } catch (err) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "MCP_DISABLED" || err.code === "MCP_SERVER_DISABLED" ? 403 : 502;
      return apiError(res, status, err.code || "UPSTREAM_ERROR", err.message);
    }
  });
}
