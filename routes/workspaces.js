import { validate } from "../lib/validate.js";

export default function mountWorkspaceRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    adminAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
    storage,
    // workspace-templates
    createTemplate,
    listTemplates,
    getTemplate,
    updateTemplate,
    deleteTemplate,
    applyTemplate,
    // workspace lifecycle
    exportWorkspaceBundle,
    deleteWorkspaceForUser,
    // workspace agent settings
    loadWorkspaceAgentSettings,
    saveWorkspaceAgentSettings,
    getWorkspaceAgentAccess,
    canEditWorkspaceAgentSettings,
    // teams
    resolveStorageUserId,
    // idempotency
    idempotencyLookup,
    idempotencyStore,
  } = deps;

  // Workspaces CRUD
  apiRoute("get", "/workspaces", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaces = await storage.listWorkspaces(req.userId);
      res.json({ _version: 1, items: workspaces });
    } catch (err) {
      console.error("Workspaces list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  const validateCreateWs = validate({ body: { name: "string" } });

  apiRoute("post", "/workspaces", storageRateLimiter, userAuth, requireScope("write"), logRequest, validateCreateWs, async (req, res) => {
    try {
      const idemKey = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
      if (idemKey) {
        const prev = await idempotencyLookup(String(idemKey), "POST:/api/workspaces", req.userId || "anonymous");
        if (prev.hit) return res.status(prev.status).json(prev.body);
      }
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : "Workspace";
      const type = req.body?.type === "team" ? "team" : "personal";
      const ws = await storage.createWorkspace(req.userId, name, type);
      if (idemKey) {
        await idempotencyStore(String(idemKey), "POST:/api/workspaces", req.userId || "anonymous", 201, ws);
      }
      res.status(201).json(ws);
    } catch (err) {
      console.error("Workspace create error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Workspace Templates
  apiRoute("get", "/workspace-templates", storageRateLimiter, userAuth, logRequest, async (req, res) => {
    try {
      const templates = await listTemplates();
      res.json({ _version: 1, items: templates });
    } catch (err) {
      console.error("Workspace templates list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspace-templates", storageRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const template = await createTemplate(req.body);
      res.status(201).json(template);
    } catch (err) {
      console.error("Workspace template create error:", err.message);
      if (err.message === "Template name is required") {
        return apiError(res, 400, "VALIDATION_ERROR", err.message, "Provide a name field.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/workspace-templates/:id", storageRateLimiter, userAuth, logRequest, async (req, res) => {
    try {
      const template = await getTemplate(req.params.id);
      if (!template) {
        return apiError(res, 404, "NOT_FOUND", "Template not found", null);
      }
      res.json(template);
    } catch (err) {
      console.error("Workspace template get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/workspace-templates/:id", storageRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const updated = await updateTemplate(req.params.id, req.body);
      if (!updated) {
        return apiError(res, 404, "NOT_FOUND", "Template not found", null);
      }
      res.json(updated);
    } catch (err) {
      console.error("Workspace template update error:", err.message);
      if (err.message === "Cannot update a default template") {
        return apiError(res, 403, "FORBIDDEN", err.message, "Default templates cannot be modified.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/workspace-templates/:id", storageRateLimiter, adminAuth, logRequest, async (req, res) => {
    try {
      const deleted = await deleteTemplate(req.params.id);
      if (!deleted) {
        return apiError(res, 404, "NOT_FOUND", "Template not found", null);
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("Workspace template delete error:", err.message);
      if (err.message === "Cannot delete a default template") {
        return apiError(res, 403, "FORBIDDEN", err.message, "Default templates cannot be deleted.");
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspace-templates/:id/apply", storageRateLimiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId.trim() : null;
      if (!workspaceId) {
        return apiError(res, 400, "VALIDATION_ERROR", "workspaceId is required", null);
      }
      const result = await applyTemplate(req.params.id, workspaceId, req.userId);
      res.json(result);
    } catch (err) {
      console.error("Workspace template apply error:", err.message);
      if (err.message === "Template not found") {
        return apiError(res, 404, "NOT_FOUND", err.message, null);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Workspace export and delete
  apiRoute("get", "/workspaces/:id/export", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      }
      const bundle = await exportWorkspaceBundle(req.userId, workspaceId);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="workspace-${workspaceId}-export.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
      console.error("Workspace export error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/workspaces/:id", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      if (req.body?.confirm !== "DELETE" && req.query?.confirm !== "DELETE") {
        return apiError(
          res,
          400,
          "CONFIRM_REQUIRED",
          'Send JSON { "confirm": "DELETE" } or ?confirm=DELETE to delete a workspace.',
          "Phase 74: destructive operation requires explicit confirmation."
        );
      }
      const result = await deleteWorkspaceForUser(req.userId, workspaceId);
      if (!result.ok) {
        const st = result.error?.includes("owner") || result.error?.includes("Only") ? 403 : 400;
        return res.status(st).json({ error: result.error, code: "DELETE_WORKSPACE_FAILED" });
      }
      res.status(204).send();
    } catch (err) {
      console.error("Workspace delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // Workspace agent settings
  apiRoute("get", "/workspaces/:id/agent-settings", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      }
      const storageUserId = await resolveStorageUserId(req.userId, workspaceId);
      const settings = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
      res.json({
        workspaceId,
        defaultSystemPrompt: settings.defaultSystemPrompt,
        memorySnippets: settings.memorySnippets,
        allowedTools: settings.allowedTools || [],
      });
    } catch (err) {
      console.error("Agent settings GET error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute(
    "put",
    "/workspaces/:id/agent-settings",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
        if (!access.allowed) {
          return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
        }
        if (!canEditWorkspaceAgentSettings(access.role)) {
          return apiError(
            res,
            403,
            "FORBIDDEN",
            "Viewers cannot edit workspace agent settings",
            "Requires admin or member role on team workspaces."
          );
        }
        const storageUserId = await resolveStorageUserId(req.userId, workspaceId);
        const saved = await saveWorkspaceAgentSettings(storageUserId, workspaceId, req.body || {});
        res.json({
          workspaceId,
          defaultSystemPrompt: saved.defaultSystemPrompt,
          memorySnippets: saved.memorySnippets,
          allowedTools: saved.allowedTools || [],
        });
      } catch (err) {
        console.error("Agent settings PUT error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );
}
