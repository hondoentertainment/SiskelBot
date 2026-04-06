// API v2 documents routes (renamed from "context" in v1)
import { randomUUID } from "crypto";
import { apiV2Route } from "../../lib/api-version.js";
import { apiV2Error } from "../../lib/api-v2-errors.js";

function parsePagination(query) {
  const cursor = query.cursor || null;
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 100);
  return { cursor, limit };
}

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

/**
 * Auto-detect content type from content string.
 * @param {string} content
 * @returns {string}
 */
function detectContentType(content) {
  if (!content || typeof content !== "string") return "text/plain";
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { JSON.parse(trimmed); return "application/json"; } catch { /* not json */ }
  }
  if (trimmed.startsWith("<?xml") || trimmed.startsWith("<")) return "text/xml";
  if (trimmed.startsWith("# ") || trimmed.includes("\n## ")) return "text/markdown";
  return "text/plain";
}

export function mountV2DocumentRoutes(app, deps) {
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

  const prefix = "/documents";
  const mw = [storageRateLimiter, v2BearerAuth, v2RateHeaders, logRequest];

  // GET /api/v2/documents — list with cursor pagination
  apiV2Route(app, "get", prefix, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const { cursor, limit } = parsePagination(req.query);
      const data = await storage.listItems("context", workspace, req.userId);
      const result = paginate(data, cursor, limit);
      res.json(result);
    } catch (err) {
      console.error("v2 documents list error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v2/documents — create
  apiV2Route(app, "post", prefix, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, content } = req.body || {};
      if (typeof title !== "string" || !title.trim()) {
        return apiV2Error(res, 400, "INVALID_INPUT", "title is required");
      }
      const id = randomUUID();
      const contentType = detectContentType(content);
      const doc = {
        id,
        title: title.trim().slice(0, 500),
        content: typeof content === "string" ? content : "",
        contentType,
        createdAt: new Date().toISOString(),
      };
      const merged = await storage.mergeItems("context", workspace, [doc]);
      const item = merged.find((x) => x.id === id) || doc;
      await logActivity(workspace, "document_added", req.userId || "anonymous", { title: doc.title, id: doc.id });
      res.status(201).json(item);
    } catch (err) {
      console.error("v2 documents create error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/documents/search — search documents
  apiV2Route(app, "get", `${prefix}/search`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const q = req.query.q || "";
      const semantic = req.query.semantic === "1";
      const { cursor, limit } = parsePagination(req.query);
      if (!q.trim()) {
        return apiV2Error(res, 400, "INVALID_INPUT", "Query parameter q is required");
      }
      let results;
      if (semantic) {
        try {
          const { semanticSearch } = await import("../../lib/embeddings.js");
          results = await semanticSearch(q, workspace, req.userId, { limit: 1000 });
        } catch {
          results = [];
        }
      } else {
        const all = await storage.listItems("context", workspace, req.userId);
        const lower = q.toLowerCase();
        results = all.filter((d) =>
          (d.title && d.title.toLowerCase().includes(lower)) ||
          (d.content && d.content.toLowerCase().includes(lower))
        );
      }
      const items = Array.isArray(results) ? results : [];
      const result = paginate(items, cursor, limit);
      res.json(result);
    } catch (err) {
      console.error("v2 documents search error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v2/documents/:id — get single
  apiV2Route(app, "get", `${prefix}/:id`, ...mw, requireScope("read"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const item = await storage.getItem("context", req.params.id, workspace);
      if (!item) return apiV2Error(res, 404, "NOT_FOUND", "Document not found");
      res.json(item);
    } catch (err) {
      console.error("v2 documents get error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v2/documents/:id — update
  apiV2Route(app, "put", `${prefix}/:id`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const { title, content } = req.body || {};
      const updated = await storage.updateItem("context", req.params.id, workspace, (existing) => {
        if (typeof title === "string" && title.trim()) existing.title = title.trim().slice(0, 500);
        if (content !== undefined) {
          existing.content = typeof content === "string" ? content : "";
          existing.contentType = detectContentType(existing.content);
        }
        return existing;
      });
      if (!updated) return apiV2Error(res, 404, "NOT_FOUND", "Document not found");
      res.json(updated);
    } catch (err) {
      console.error("v2 documents update error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v2/documents/:id
  apiV2Route(app, "delete", `${prefix}/:id`, ...mw, requireScope("write"), async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const deleted = await storage.deleteItem("context", req.params.id, workspace);
      if (!deleted) return apiV2Error(res, 404, "NOT_FOUND", "Document not found");
      res.status(204).send();
    } catch (err) {
      console.error("v2 documents delete error:", err.message);
      return apiV2Error(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
