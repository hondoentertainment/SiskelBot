// API v2 conversations routes
import { randomUUID } from "crypto";
import { apiV2Route } from "../../lib/api-version.js";
import { apiV2Error } from "../../lib/api-v2-errors.js";

/**
 * Parse cursor-based pagination params from query.
 * @param {object} query
 * @returns {{ cursor: string|null, limit: number }}
 */
function parsePagination(query) {
  const cursor = query.cursor || null;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
  return { cursor, limit };
}

/**
 * Apply cursor-based pagination to an array of items.
 * Cursor is the base64-encoded id of the last item seen.
 * @param {Array} items - Full list sorted by creation time
 * @param {string|null} cursor - Cursor from previous page
 * @param {number} limit - Max items to return
 * @returns {{ items: Array, cursor: string|null, hasMore: boolean }}
 */
function paginate(items, cursor, limit) {
  let startIdx = 0;
  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, "base64").toString("utf8");
      const idx = items.findIndex((i) => i.id === decoded);
      if (idx >= 0) startIdx = idx + 1;
    } catch {
      // invalid cursor, start from beginning
    }
  }
  const page = items.slice(startIdx, startIdx + limit);
  const hasMore = startIdx + limit < items.length;
  const nextCursor = page.length > 0 && hasMore
    ? Buffer.from(page[page.length - 1].id).toString("base64")
    : null;
  return { items: page, cursor: nextCursor, hasMore };
}

export function mountV2ConversationRoutes(app, deps) {
  const {
    requireScope,
    logRequest,
    storageRateLimiter,
    sanitizeWorkspace,
    storage,
    logActivity,
    v2BearerAuth,
    v2RateHeaders,
  } = deps;

  const prefix = "/conversations";
  const mw = [storageRateLimiter, v2BearerAuth, v2RateHeaders, logRequest];

  // GET /api/v2/conversations — list with cursor pagination
  apiV2Route(app, "get", prefix, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const { cursor, limit } = parsePagination(req.query);
      const data = await storage.listItems("conversations", workspace);
      const result = paginate(data, cursor, limit);
      res.json(result);
    } catch (err) {
      console.error("v2 conversations list error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/conversations/search — search conversations
  apiV2Route(app, "get", `${prefix}/search`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const q = req.query.q || "";
      const { cursor, limit } = parsePagination(req.query);
      if (!q.trim()) {
        return apiV2Error(res, 400, "INVALID_INPUT", "Query parameter q is required");
      }
      const { searchConversations } = await import("../../lib/conversation-search.js");
      const all = await searchConversations(q, userId, workspace, { limit: 1000, offset: 0 });
      const items = all.results || all.items || (Array.isArray(all) ? all : []);
      const result = paginate(items, cursor, limit);
      res.json(result);
    } catch (err) {
      console.error("v2 conversations search error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v2/conversations — create
  apiV2Route(app, "post", prefix, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, messages, meta } = req.body || {};
      if (!title && (!Array.isArray(messages) || messages.length === 0)) {
        return apiV2Error(res, 400, "INVALID_INPUT", "title or messages required");
      }
      const convId = randomUUID();
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
      console.error("v2 conversations create error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/conversations/:id — get single
  apiV2Route(app, "get", `${prefix}/:id`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("conversations", req.params.id, workspace);
      if (!item) return apiV2Error(res, 404, "NOT_FOUND", "Conversation not found");
      res.json(item);
    } catch (err) {
      console.error("v2 conversations get error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v2/conversations/:id — update
  apiV2Route(app, "put", `${prefix}/:id`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, messages, meta } = req.body || {};
      const updated = await storage.updateItem("conversations", req.params.id, workspace, (existing) => {
        if (typeof title === "string") existing.title = title.trim().slice(0, 200);
        if (Array.isArray(messages)) existing.messages = messages;
        if (meta && typeof meta === "object") existing.meta = meta;
        return existing;
      });
      if (!updated) return apiV2Error(res, 404, "NOT_FOUND", "Conversation not found");
      res.json(updated);
    } catch (err) {
      console.error("v2 conversations update error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v2/conversations/:id
  apiV2Route(app, "delete", `${prefix}/:id`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const deleted = await storage.deleteItem("conversations", req.params.id, workspace);
      if (!deleted) return apiV2Error(res, 404, "NOT_FOUND", "Conversation not found");
      res.status(204).send();
    } catch (err) {
      console.error("v2 conversations delete error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/conversations/:id/export — export in markdown/json/html
  apiV2Route(app, "get", `${prefix}/:id/export`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const format = req.query.format || "json";
      if (!["markdown", "json", "html"].includes(format)) {
        return apiV2Error(res, 400, "INVALID_FORMAT", "format must be markdown, json, or html");
      }
      const { exportConversation } = await import("../../lib/conversation-export.js");
      const result = await exportConversation(req.params.id, format, userId, workspace);
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.content);
    } catch (err) {
      if (err.message === "Conversation not found") return apiV2Error(res, 404, "NOT_FOUND", err.message);
      console.error("v2 conversations export error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v2/conversations/:id/share — create share link
  apiV2Route(app, "post", `${prefix}/:id/share`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
      const userId = req.userId || "anonymous";
      const { expiresIn, password } = req.body || {};
      const item = await storage.getItem("conversations", req.params.id, workspace, userId);
      if (!item) return apiV2Error(res, 404, "NOT_FOUND", "Conversation not found");
      const { createShareLink } = await import("../../lib/conversation-sharing.js");
      const result = await createShareLink(req.params.id, userId, workspace, { expiresIn, password });
      res.status(201).json(result);
    } catch (err) {
      console.error("v2 conversations share error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
