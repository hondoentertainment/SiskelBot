/**
 * Unified search routes — inverted index search across conversations and knowledge.
 */
import {
  searchConversations,
  reindex,
  indexKnowledgeDoc,
} from "../lib/conversation-search.js";
import { listAllDocs } from "../lib/knowledge-store.js";

export function mountSearchRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    requireScope,
    logRequest,
    storageRateLimiter,
    sanitizeWorkspace,
    adminAuth,
  } = deps;

  // GET /api/v1/search?q=...&type=conversations|knowledge|all
  apiRoute("get", "/search", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const q = req.query.q || req.query.query || "";
      const type = req.query.type || "all";
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const workspace = sanitizeWorkspace(req.query.workspace);

      if (!q.trim()) {
        return res.json({ results: [], total: 0, query: "" });
      }

      const validTypes = ["conversations", "knowledge", "all"];
      if (!validTypes.includes(type)) {
        return apiError(res, 400, "INVALID_TYPE", `type must be one of: ${validTypes.join(", ")}`, "Use ?type=all for combined search.");
      }

      const result = await searchConversations(q, req.userId || "anonymous", workspace, {
        limit,
        offset,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        type,
      });

      res.json({ ...result, query: q.trim(), type });
    } catch (err) {
      console.error("[search] Error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Search failed.");
    }
  });

  // POST /api/v1/search/reindex — rebuild the full index (admin only)
  apiRoute("post", "/search/reindex", adminAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
      const userId = req.userId || "anonymous";

      // Fetch knowledge docs for this workspace
      const knowledgeDocs = await listAllDocs({ workspace });

      const result = await reindex(userId, workspace, knowledgeDocs);

      res.json({
        ok: true,
        message: "Search index rebuilt",
        ...result,
      });
    } catch (err) {
      console.error("[search] Reindex error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Reindex failed.");
    }
  });
}
