// Context CRUD + sync routes extracted from server.js
import { randomUUID } from "crypto";

export function mountContextRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    requireScope,
    logRequest,
    storageRateLimiter,
    readRateLimiter,
    sanitizeWorkspace,
    storage,
    logActivity,
  } = deps;

  apiRoute("get", "/context", storageRateLimiter, readRateLimiter, userAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const data = await storage.listItems("context", workspace, req.userId);
      res.json({ _version: 1, items: data });
    } catch (err) {
      console.error("Storage context list error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/context", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, content } = req.body || {};
      if (typeof title !== "string" || !title.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "title required", "Send { title: string, content?: string }.");
      }
      const id = (req.body?.id && String(req.body.id).trim()) || randomUUID();
      const doc = {
        id,
        title: title.trim().slice(0, 500),
        content: typeof content === "string" ? content : "",
        createdAt: new Date().toISOString(),
      };
      const merged = await storage.mergeItems("context", workspace, [doc]);
      const item = merged.find((x) => x.id === id) || doc;
      await logActivity(workspace, "context_added", req.userId || "anonymous", { title: doc.title, id: doc.id });
      res.status(201).json(item);
    } catch (err) {
      console.error("Storage context add error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("get", "/context/:id", storageRateLimiter, readRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("context", req.params.id, workspace);
      if (!item) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(item);
    } catch (err) {
      console.error("Storage context get error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("put", "/context/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, content } = req.body || {};
      const updated = await storage.updateItem("context", req.params.id, workspace, (existing) => {
        if (typeof title === "string" && title.trim()) existing.title = title.trim().slice(0, 500);
        if (content !== undefined) existing.content = typeof content === "string" ? content : "";
        return existing;
      });
      if (!updated) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.json(updated);
    } catch (err) {
      console.error("Storage context update error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("delete", "/context/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const deleted = await storage.deleteItem("context", req.params.id, workspace);
      if (!deleted) return res.status(404).json({ error: "Not found", code: "NOT_FOUND" });
      res.status(204).send();
    } catch (err) {
      console.error("Storage context delete error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  apiRoute("post", "/context/sync", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const valid = items.filter((x) => x && x.id && typeof x.title === "string");
      const merged = await storage.mergeItems("context", workspace, valid);
      res.json({ _version: 1, items: merged });
    } catch (err) {
      console.error("Storage context sync error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
