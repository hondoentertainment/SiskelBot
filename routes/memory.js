/**
 * Phase 20: Agent long-term memory routes.
 * GET    /api/v1/memory          — list memories
 * POST   /api/v1/memory          — add memory
 * DELETE /api/v1/memory/:id      — forget
 * GET    /api/v1/memory/search   — search
 * GET    /api/v1/memory/stats    — memory statistics
 */
import {
  remember,
  recall,
  forget,
  listMemories,
  getMemoryStats,
} from "../lib/agent-memory.js";

export function mountMemoryRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    sanitizeWorkspace,
    storageRateLimiter,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());

  // GET /api/v1/memory — list memories
  apiRoute("get", "/memory", limiter, userAuth, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId;
      const category = req.query?.category || undefined;
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      const offset = req.query?.offset ? Number(req.query.offset) : undefined;
      const sortBy = req.query?.sortBy || undefined;

      const result = await listMemories(userId, workspace, {
        category,
        limit,
        offset,
        sortBy,
      });
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/memory/search — search memories
  apiRoute("get", "/memory/search", limiter, userAuth, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId;
      const q = req.query?.q || "";
      const category = req.query?.category || undefined;
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      const minImportance = req.query?.minImportance ? Number(req.query.minImportance) : undefined;

      if (!q.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "q query parameter is required");
      }

      const result = await recall(userId, workspace, q, {
        category,
        limit,
        minImportance,
      });
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/memory/stats — memory statistics
  apiRoute("get", "/memory/stats", limiter, userAuth, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId;

      const stats = await getMemoryStats(userId, workspace);
      res.json({ _version: 1, ...stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/memory — add memory
  apiRoute("post", "/memory", limiter, userAuth, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId;
      const { content, category, importance, source, metadata } = req.body || {};

      if (!content || typeof content !== "string" || !content.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "content is required");
      }

      const result = await remember(userId, workspace, {
        content,
        category,
        importance,
        source,
        metadata,
      });
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (err.message.includes("category") || err.message.includes("importance") || err.message.includes("content")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/memory/:id — forget
  apiRoute("delete", "/memory/:id", limiter, userAuth, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId;

      const result = await forget(userId, workspace, req.params.id);
      if (!result.ok) {
        return apiError(res, 404, "NOT_FOUND", result.error);
      }
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
