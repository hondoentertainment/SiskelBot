// Conversations CRUD + branching routes extracted from server.js
import { randomUUID } from "crypto";

export function mountConversationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    requireScope,
    logRequest,
    storageRateLimiter,
    sanitizeWorkspace,
    storage,
    logActivity,
    branchConversation,
    getConversationTree,
    listConversationBranches,
    getConversationBranch,
    deleteConversationBranch,
  } = deps;

  apiRoute("get", "/conversations", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const data = await storage.listItems("conversations", workspace);
      res.json({ _version: 1, items: data });
    } catch (err) {
      console.error("Storage conversations list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/conversations", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { id, title, messages, meta } = req.body || {};
      const convId = (id && String(id).trim()) || randomUUID();
      const item = {
        id: convId,
        title: typeof title === "string" ? title.trim().slice(0, 200) : "Untitled",
        messages: Array.isArray(messages) ? messages : [],
        meta: meta && typeof meta === "object" ? meta : {},
        createdAt: new Date().toISOString(),
      };
      const merged = await storage.mergeItems("conversations", workspace, [item]);
      const out = merged.find((x) => x.id === convId) || item;
      await logActivity(workspace, "conversation_created", req.userId || "anonymous", { title: item.title, id: out.id });
      res.status(201).json(out);
    } catch (err) {
      console.error("Storage conversations add error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/conversations/:id", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("conversations", req.params.id, workspace);
      if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(item);
    } catch (err) {
      console.error("Storage conversations get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/conversations/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, messages, meta } = req.body || {};
      const updated = await storage.updateItem("conversations", req.params.id, workspace, (existing) => {
        if (typeof title === "string") existing.title = title.trim().slice(0, 200);
        if (Array.isArray(messages)) existing.messages = messages;
        if (meta && typeof meta === "object") existing.meta = meta;
        return existing;
      });
      if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(updated);
    } catch (err) {
      console.error("Storage conversations update error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/conversations/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const deleted = await storage.deleteItem("conversations", req.params.id, workspace);
      if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.status(204).send();
    } catch (err) {
      console.error("Storage conversations delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // --- Conversation branching & forking ---
  apiRoute("post", "/conversations/:id/branch", storageRateLimiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
      const userId = req.userId || "anonymous";
      const { atMessageIndex, label } = req.body || {};
      if (typeof atMessageIndex !== "number" || !Number.isInteger(atMessageIndex) || atMessageIndex < 0) {
        return apiError(res, 400, "INVALID_INPUT", "atMessageIndex must be a non-negative integer.");
      }
      const branch = await branchConversation(req.params.id, atMessageIndex, userId, { label, workspace });
      res.status(201).json(branch);
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.message.includes("Invalid branch point")) return apiError(res, 400, "INVALID_INPUT", err.message);
      console.error("Branch conversation error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/conversations/:id/tree", storageRateLimiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const tree = await getConversationTree(req.params.id, workspace, userId);
      if (!tree) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(tree);
    } catch (err) {
      console.error("Conversation tree error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/conversations/:id/branches", storageRateLimiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const branches = await listConversationBranches(req.params.id, workspace, userId);
      res.json({ branches });
    } catch (err) {
      console.error("List branches error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/conversations/branches/:branchId", storageRateLimiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const branch = await getConversationBranch(req.params.branchId, workspace, userId);
      if (!branch) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(branch);
    } catch (err) {
      console.error("Get branch error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/conversations/branches/:branchId", storageRateLimiter, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const deleted = await deleteConversationBranch(req.params.branchId, workspace, userId);
      if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.status(204).send();
    } catch (err) {
      console.error("Delete branch error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
