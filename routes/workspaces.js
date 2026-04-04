import { randomUUID } from "crypto";

export function mountWorkspaceRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    adminAuth,
    requireScope,
    logRequest,
    storageRateLimiter,
    workspaceRateLimiter,
    sanitizeWorkspace,
    storage,
    idempotencyLookup,
    idempotencyStore,
    createTemplate,
    listTemplates,
    getTemplate,
    updateTemplate,
    deleteTemplate,
    applyTemplate,
    exportWorkspaceBundle,
    deleteWorkspaceForUser,
    loadWorkspaceAgentSettings,
    saveWorkspaceAgentSettings,
    getWorkspaceAgentAccess,
    canEditWorkspaceAgentSettings,
    resolveStorageUserId,
    getWorkspaceChunkingConfig,
    setWorkspaceChunkingConfig,
    canAccessWorkspace,
    createInviteCode,
    joinByInviteCode,
    getWorkspaceMembers,
    getWorkspaceActivity,
    logActivity,
    getOnlineUsers,
    storeMemory,
    getMemories,
    searchMemories,
    updateAgentMemory,
    deleteAgentMemory,
    extractPotentialMemories,
    exportWorkspaceMigration,
    importWorkspaceMigration,
    validateBundle,
    diffWorkspaces,
    marketplaceListInstalled,
    marketplaceRateLimiter,
    listRbacRoles,
    createCustomRole,
    updateCustomRole,
    deleteCustomRole,
    assignRole,
    getAvailableRegions,
    setDataResidency,
    getDataResidency,
    generateComplianceReport,
    getRetentionPolicy,
    setRetentionPolicy,
    scanTextForPII,
    getWorkspaceMemoryStats,
    listInstalledMarketplacePacks,
    installMarketplacePack,
    setMarketplacePackEnabled,
    getWorkspaceMarketplacePolicy,
    saveWorkspaceMarketplacePolicy,
    appendAuditLog,
  } = deps;

  // --- Workspaces CRUD ---
  apiRoute("get", "/workspaces", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaces = await storage.listWorkspaces(req.userId);
      res.json({ _version: 1, items: workspaces });
    } catch (err) {
      console.error("Workspaces list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
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
  // --- Workspace Templates ---
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

  // --- Workspace export & delete ---
  apiRoute("get", "/workspaces/:id/export", storageRateLimiter, workspaceRateLimiter(), userAuth, requireScope("read"), logRequest, async (req, res) => {
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

  apiRoute("delete", "/workspaces/:id", storageRateLimiter, workspaceRateLimiter(), userAuth, requireScope("write"), logRequest, async (req, res) => {
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

  // --- Agent Memory Persistence ---
  apiRoute("get", "/workspaces/:id/memories", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const su = await resolveStorageUserId(req.userId, workspaceId);
      const options = {};
      if (req.query.category) options.category = req.query.category;
      if (req.query.active !== undefined) options.activeOnly = req.query.active !== "false";
      if (req.query.limit) options.limit = Number(req.query.limit);
      if (req.query.offset) options.offset = Number(req.query.offset);
      const memories = await getMemories(workspaceId, su, options);
      res.json({ items: memories });
    } catch (err) {
      console.error("Agent memories list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces/:id/memories", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const su = await resolveStorageUserId(req.userId, workspaceId);
      const { content, category, source, confidence, consent } = req.body || {};
      const result = await storeMemory(workspaceId, su, { content, category, source, confidence, consent });
      if (!result.ok) return apiError(res, 400, "STORE_MEMORY_FAILED", result.error, null);
      res.status(201).json(result.memory);
    } catch (err) {
      console.error("Agent memory store error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/workspaces/:id/memories/:memoryId", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const su = await resolveStorageUserId(req.userId, workspaceId);
      const result = await updateAgentMemory(req.params.memoryId, req.body || {}, workspaceId, su);
      if (!result.ok) {
        const status = result.error === "Memory not found" ? 404 : 400;
        return apiError(res, status, "UPDATE_MEMORY_FAILED", result.error, null);
      }
      res.json(result.memory);
    } catch (err) {
      console.error("Agent memory update error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/workspaces/:id/memories/:memoryId", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const su = await resolveStorageUserId(req.userId, workspaceId);
      const result = await deleteAgentMemory(req.params.memoryId, workspaceId, su);
      if (!result.ok) return apiError(res, 404, "DELETE_MEMORY_FAILED", result.error, null);
      res.status(204).send();
    } catch (err) {
      console.error("Agent memory delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/workspaces/:id/memories/search", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const su = await resolveStorageUserId(req.userId, workspaceId);
      const q = req.query.q || "";
      const results = await searchMemories(workspaceId, su, q);
      res.json({ items: results });
    } catch (err) {
      console.error("Agent memory search error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces/:id/memories/extract", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const { messages, conversationId } = req.body || {};
      if (!Array.isArray(messages)) return apiError(res, 400, "INVALID_INPUT", "messages must be an array", null);
      const suggestions = extractPotentialMemories(messages, { workspaceId, userId: req.userId, conversationId });
      res.json({ suggestions });
    } catch (err) {
      console.error("Agent memory extract error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Workspace Migration Tooling ---
  apiRoute("get", "/workspaces/:id/migrate/export", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const options = {
        userId: req.userId,
        includeConversations: req.query.conversations !== "false",
        includeKnowledge: req.query.knowledge !== "false",
        includeMemories: req.query.memories !== "false",
        includeWebhooks: req.query.webhooks !== "false",
      };
      const bundle = await exportWorkspaceMigration(workspaceId, options);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="workspace-${workspaceId}-migration.json"`);
      res.send(JSON.stringify(bundle, null, 2));
    } catch (err) {
      console.error("Workspace migration export error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces/:id/migrate/import", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const bundle = req.body;
      if (!bundle || typeof bundle !== "object") return apiError(res, 400, "INVALID_INPUT", "Request body must be a JSON workspace bundle", null);
      const strategy = req.query.strategy || req.body._strategy || "merge";
      const result = await importWorkspaceMigration(bundle, req.userId, {
        targetWorkspaceId: workspaceId,
        strategy,
      });
      if (!result.ok) return apiError(res, 400, "IMPORT_FAILED", result.error, null);
      res.json({ ok: true, stats: result.stats });
    } catch (err) {
      console.error("Workspace migration import error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces/:id/migrate/validate", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const bundle = req.body;
      if (!bundle || typeof bundle !== "object") return apiError(res, 400, "INVALID_INPUT", "Request body must be a JSON workspace bundle", null);
      const result = validateBundle(bundle);
      res.json(result);
    } catch (err) {
      console.error("Workspace migration validate error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces/:id/migrate/diff", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const bundle = req.body;
      if (!bundle || typeof bundle !== "object") return apiError(res, 400, "INVALID_INPUT", "Request body must be a JSON workspace bundle", null);
      const currentBundle = await exportWorkspaceMigration(workspaceId, { userId: req.userId });
      const result = diffWorkspaces(currentBundle, bundle);
      res.json(result);
    } catch (err) {
      console.error("Workspace migration diff error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Agent settings ---
  apiRoute("get", "/workspaces/:id/agent-settings", storageRateLimiter, workspaceRateLimiter(), userAuth, requireScope("read"), logRequest, async (req, res) => {
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
        agentPolicy: settings.agentPolicy || {},
        memoryStats: getWorkspaceMemoryStats(settings),
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
    workspaceRateLimiter(),
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
          agentPolicy: saved.agentPolicy || {},
          memoryStats: getWorkspaceMemoryStats(saved),
        });
      } catch (err) {
        console.error("Agent settings PUT error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  apiRoute("get", "/workspaces/:id/agent-memory/stats", storageRateLimiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      }
      const storageUserId = await resolveStorageUserId(req.userId, workspaceId);
      const settings = await loadWorkspaceAgentSettings(storageUserId, workspaceId);
      res.json({ workspaceId, memory: getWorkspaceMemoryStats(settings) });
    } catch (err) {
      console.error("Agent memory stats GET error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/workspaces/:id/marketplace/packs", storageRateLimiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) {
        return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      }
      const packs = await listInstalledMarketplacePacks(workspaceId);
      res.json({ workspaceId, packs });
    } catch (err) {
      console.error("Marketplace packs list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute(
    "post",
    "/workspaces/:id/marketplace/install",
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
          return apiError(res, 403, "FORBIDDEN", "Viewers cannot install marketplace packs", null);
        }
        const out = await installMarketplacePack(workspaceId, req.body?.manifest);
        if (!out.ok) {
          const status = out.code === "INVALID_MANIFEST" ? 400 : 403;
          return res.status(status).json({ error: out.error || "Install failed", code: out.code, details: out.errors || [] });
        }
        appendAuditLog({
          action: "marketplace_install",
          payload: { workspaceId, packId: out.pack.id, version: out.pack.version },
          ok: true,
        });
        res.status(201).json({ workspaceId, pack: out.pack });
      } catch (err) {
        console.error("Marketplace install error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  apiRoute(
    "post",
    "/workspaces/:id/marketplace/packs/:packId/:op(enable|disable)",
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
          return apiError(res, 403, "FORBIDDEN", "Viewers cannot modify marketplace packs", null);
        }
        const enable = String(req.params.op) === "enable";
        const out = await setMarketplacePackEnabled(workspaceId, req.params.packId, enable);
        if (!out.ok) {
          return res.status(out.code === "NOT_FOUND" ? 404 : 400).json({ error: out.error || "Operation failed", code: out.code });
        }
        appendAuditLog({
          action: enable ? "marketplace_enable" : "marketplace_disable",
          payload: { workspaceId, packId: out.pack.id, version: out.pack.version },
          ok: true,
        });
        res.json({ workspaceId, pack: out.pack });
      } catch (err) {
        console.error("Marketplace enable/disable error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  apiRoute("get", "/workspaces/:id/marketplace/policy", storageRateLimiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
      const policy = await getWorkspaceMarketplacePolicy(workspaceId);
      res.json({ workspaceId, policy });
    } catch (err) {
      console.error("Marketplace policy GET error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute(
    "put",
    "/workspaces/:id/marketplace/policy",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const access = await getWorkspaceAgentAccess(req.userId, workspaceId);
        if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Workspace not found or access denied", null);
        if (!canEditWorkspaceAgentSettings(access.role)) {
          return apiError(res, 403, "FORBIDDEN", "Viewers cannot edit marketplace policy", null);
        }
        const policy = await saveWorkspaceMarketplacePolicy(workspaceId, req.body || {});
        appendAuditLog({
          action: "marketplace_policy_update",
          payload: { workspaceId, keys: Object.keys(policy) },
          ok: true,
        });
        res.json({ workspaceId, policy });
      } catch (err) {
        console.error("Marketplace policy PUT error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  // --- Per-workspace chunking config ---
  apiRoute("get", "/workspaces/:id/chunking-config", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const config = await getWorkspaceChunkingConfig(workspaceId);
      res.json({ workspaceId, ...config });
    } catch (err) {
      console.error("Chunking config GET error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/workspaces/:id/chunking-config", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.params.id);
      const body = req.body || {};
      const saved = await setWorkspaceChunkingConfig(workspaceId, body);
      res.json({ workspaceId, ...saved });
    } catch (err) {
      if (err.code === "INVALID_INPUT") {
        return apiError(res, 400, "INVALID_INPUT", err.message, "Workspace must be alphanumeric, 1-50 chars.");
      }
      console.error("Chunking config PUT error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Team workspaces ---
  apiRoute("post", "/workspaces/join", storageRateLimiter, userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const code = req.body?.code?.trim?.();
      if (!code) return apiError(res, 400, "INVALID_INPUT", "code required", "Send { code: string }.");
      const result = await joinByInviteCode(code, req.userId);
      if (!result.ok) {
        const status = result.error?.includes("Invalid") || result.error?.includes("expired") ? 400 : 409;
        return res.status(status).json({ error: result.error, code: "JOIN_FAILED" });
      }
      const members = await getWorkspaceMembers(result.workspaceId);
      const ownerId = members?.ownerId || req.userId;
      const ws = (await storage.getWorkspaceById(ownerId, result.workspaceId)) || {
        id: result.workspaceId,
        name: result.workspaceName || "Team Workspace",
      };
      res.status(200).json({ ok: true, workspace: { id: result.workspaceId, name: ws.name || result.workspaceName } });
    } catch (err) {
      console.error("Workspace join error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/workspaces/:id/invite", storageRateLimiter, workspaceRateLimiter(), userAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const access = await canAccessWorkspace(workspaceId, req.userId);
      if (!access.allowed || (access.role !== "admin" && access.role !== "member")) {
        return apiError(res, 403, "FORBIDDEN", "Admin or member role required to create invites", null);
      }
      const ownerId = access.ownerId || req.userId;
      const opts = {};
      if (req.body?.expiresInHours != null) opts.expiresInHours = Number(req.body.expiresInHours);
      if (req.body?.maxUses != null) opts.maxUses = Number(req.body.maxUses);
      const inv = await createInviteCode(workspaceId, req.userId, opts);
      const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get("host") || "localhost"}`;
      res.status(201).json({ code: inv.code, inviteLink: `${baseUrl}?join=${inv.code}`, expiresAt: inv.expiresAt, maxUses: inv.maxUses });
    } catch (err) {
      console.error("Invite create error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/workspaces/:id/members", storageRateLimiter, workspaceRateLimiter(), userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const access = await canAccessWorkspace(workspaceId, req.userId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
      const entry = await getWorkspaceMembers(workspaceId);
      if (!entry) return res.json({ ownerId: null, members: [] });
      res.json({ ownerId: entry.ownerId, members: entry.members || [] });
    } catch (err) {
      console.error("Members list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/workspaces/:id/activity", storageRateLimiter, workspaceRateLimiter(), userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const access = await canAccessWorkspace(workspaceId, req.userId);
      if (!access.allowed) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
      const items = await getWorkspaceActivity(workspaceId, limit);
      res.json({ items });
    } catch (err) {
      console.error("Activity list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Presence ---
  apiRoute("get", "/workspaces/:id/presence", storageRateLimiter, workspaceRateLimiter(), userAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = req.params.id;
      const access = await canAccessWorkspace(workspaceId, req.userId);
      const isTeamWorkspace = !!(await getWorkspaceMembers(workspaceId));
      if (!access.allowed && isTeamWorkspace) return apiError(res, 403, "FORBIDDEN", "Access denied", null);
      const online = getOnlineUsers(workspaceId);
      res.json({ online });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Workspace plugins ---
  apiRoute("get", "/workspaces/:id/plugins", marketplaceRateLimiter, workspaceRateLimiter(), userAuth, logRequest, (req, res) => {
    try {
      const workspaceId = req.params.id;
      const packs = marketplaceListInstalled(workspaceId);
      res.json({ _version: 1, workspaceId, packs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/PLUGINS.md.");
    }
  });

  // --- Granular RBAC routes ---
  apiRoute("get", "/workspaces/:id/roles", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const roles = await listRbacRoles(req.params.id);
      res.json({ ok: true, roles });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/workspaces/:id/roles", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { name, permissions } = req.body || {};
      if (!name) return apiError(res, 400, "BAD_REQUEST", "Role name is required");
      const role = await createCustomRole(req.params.id, name, permissions);
      res.status(201).json({ ok: true, role });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  apiRoute("put", "/workspaces/:id/roles/:roleId", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const updated = await updateCustomRole(req.params.id, req.params.roleId, req.body || {});
      if (!updated) return apiError(res, 404, "NOT_FOUND", "Role not found");
      res.json({ ok: true, role: updated });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  apiRoute("delete", "/workspaces/:id/roles/:roleId", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const deleted = await deleteCustomRole(req.params.id, req.params.roleId);
      if (!deleted) return apiError(res, 404, "NOT_FOUND", "Role not found");
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  apiRoute("post", "/workspaces/:id/members/:userId/role", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { roleId } = req.body || {};
      if (!roleId) return apiError(res, 400, "BAD_REQUEST", "roleId is required");
      const result = await assignRole(req.params.id, req.params.userId, roleId);
      res.json({ ok: true, assignment: result });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  // --- Compliance & Data Residency ---
  apiRoute("get", "/workspaces/:id/compliance/residency", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const residency = await getDataResidency(req.params.id);
      const regions = getAvailableRegions();
      res.json({ ok: true, residency, availableRegions: regions });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/workspaces/:id/compliance/residency", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { region } = req.body || {};
      if (!region) return apiError(res, 400, "BAD_REQUEST", "region is required");
      const result = await setDataResidency(req.params.id, region);
      res.json({ ok: true, residency: result });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  apiRoute("get", "/workspaces/:id/compliance/report", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const report = await generateComplianceReport(req.params.id, {
        activityLimit: Number(req.query.activityLimit) || 200,
      });
      res.json({ ok: true, report });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/workspaces/:id/compliance/retention", storageRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const policy = await getRetentionPolicy(req.params.id);
      res.json({ ok: true, policy });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/workspaces/:id/compliance/retention", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const policy = await setRetentionPolicy(req.params.id, req.body || {});
      res.json({ ok: true, policy });
    } catch (err) {
      return apiError(res, 400, "BAD_REQUEST", err.message);
    }
  });

  apiRoute("post", "/workspaces/:id/compliance/pii-scan", storageRateLimiter, userAuth, requireScope("admin"), logRequest, async (req, res) => {
    try {
      const { texts } = req.body || {};
      if (!texts) return apiError(res, 400, "BAD_REQUEST", "texts array is required");
      const result = scanTextForPII(texts);
      res.json({ ok: true, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
