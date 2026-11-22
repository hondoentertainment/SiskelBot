/**
 * OpenAPI tool factory.
 * GET    /api/v1/workspaces/:id/openapi-tools
 * POST   /api/v1/workspaces/:id/openapi-tools
 * DELETE /api/v1/workspaces/:id/openapi-tools/:importId
 */
import {
  listOpenApiImports,
  importOpenApiSpec,
  deleteOpenApiImport,
  openApiToolsEnabled,
} from "../lib/openapi-tool-factory.js";
import { getWorkspaceAgentAccess, canEditWorkspaceAgentSettings } from "../lib/workspace-agent-settings.js";
import { sanitizeWorkspace } from "../lib/storage.js";

export function mountOpenApiToolRoutes(app, deps) {
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

  apiRoute("get", "/workspaces/:id/openapi-tools", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, false))) return;
      res.json({
        workspaceId,
        enabled: openApiToolsEnabled(),
        writeEnabled: process.env.OPENAPI_TOOLS_WRITE === "1",
        imports: await listOpenApiImports(workspaceId),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/workspaces/:id/openapi-tools", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, true))) return;
      const body = req.body || {};
      const imported = await importOpenApiSpec(workspaceId, {
        name: body.name,
        spec: body.spec,
        authSecretName: body.authSecretName,
        enabled: body.enabled,
        maxPerMinute: body.maxPerMinute,
      });
      res.status(201).json({ import: imported });
    } catch (err) {
      const status = err.code === "INVALID_INPUT" || err.code === "LIMIT_EXCEEDED" ? 400 : 500;
      return apiError(res, status, err.code || "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/workspaces/:id/openapi-tools/:importId", log, auth, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (!(await access(req, res, workspaceId, true))) return;
      const removed = await deleteOpenApiImport(workspaceId, req.params.importId);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Import not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
