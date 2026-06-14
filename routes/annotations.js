/**
 * Phase 41.4: Collaborative annotations API.
 *
 * GET    /api/v1/annotations?target=message:abc&workspace=ws&includeReplies=1
 * POST   /api/v1/annotations                       — create annotation
 * PUT    /api/v1/annotations/:id                   — update text (author only)
 * DELETE /api/v1/annotations/:id                   — delete (author only)
 * POST   /api/v1/annotations/:id/reply             — reply to annotation
 * POST   /api/v1/annotations/:id/react             — toggle emoji reaction
 * POST   /api/v1/annotations/:id/resolve           — mark resolved
 * POST   /api/v1/annotations/:id/unresolve         — mark unresolved
 * GET    /api/v1/annotations/unread                — unread annotations for user
 * POST   /api/v1/annotations/read                  — mark annotations read
 * GET    /api/v1/annotations/:id/thread            — full thread (annotation + replies)
 */
import {
  createAnnotation,
  getAnnotations,
  updateAnnotation,
  deleteAnnotation,
  replyToAnnotation,
  addReaction,
  resolveAnnotation,
  unresolveAnnotation,
  getUnreadAnnotations,
  markAnnotationsRead,
  getAnnotationThread,
} from "../lib/annotations.js";

function parseTarget(target) {
  if (typeof target !== "string") return { type: null, id: null };
  const idx = target.indexOf(":");
  if (idx <= 0) return { type: null, id: null };
  return { type: target.slice(0, idx), id: target.slice(idx + 1) };
}

export function mountAnnotationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    sanitizeWorkspace,
    storageRateLimiter,
  } = deps;

  const limiter = storageRateLimiter || ((_req, _res, next) => next());

  // GET /api/v1/annotations?target=message:abc&includeReplies=1
  apiRoute("get", "/annotations", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const target = String(req.query?.target || "");
      const { type, id } = parseTarget(target);
      if (!type || !id) {
        return apiError(res, 400, "INVALID_INPUT", "target query parameter required (format type:id)");
      }
      const includeReplies = req.query?.includeReplies !== "0" && req.query?.includeReplies !== "false";
      const includeResolved = req.query?.includeResolved === "1" || req.query?.includeResolved === "true";
      const items = await getAnnotations(type, id, {
        workspaceId,
        includeReplies,
        includeResolved,
        userId: req.userId,
      });
      res.json({ _version: 1, items });
    } catch (err) {
      if (/targetType/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/annotations/unread
  apiRoute("get", "/annotations/unread", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const items = await getUnreadAnnotations(userId, workspaceId);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/annotations/read
  apiRoute("post", "/annotations/read", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const ids = Array.isArray(req.body?.annotationIds) ? req.body.annotationIds : [];
      const result = await markAnnotationsRead(userId, ids, workspaceId);
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/annotations/:id/thread
  apiRoute("get", "/annotations/:id/thread", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const thread = await getAnnotationThread(req.params.id, workspaceId);
      if (!thread) {
        return apiError(res, 404, "NOT_FOUND", "annotation not found");
      }
      res.json({ _version: 1, ...thread });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/annotations
  apiRoute("post", "/annotations", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const { targetType, targetId, text, anchor, parentId } = req.body || {};
      if (!targetType || !targetId) {
        return apiError(res, 400, "INVALID_INPUT", "targetType and targetId are required");
      }
      const ann = await createAnnotation(targetType, targetId, {
        workspaceId,
        userId,
        text,
        anchor,
        parentId,
      });
      res.status(201).json({ _version: 1, annotation: ann });
    } catch (err) {
      if (/required|targetType|parentId/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // PUT /api/v1/annotations/:id
  apiRoute("put", "/annotations/:id", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const { text } = req.body || {};
      const ann = await updateAnnotation(req.params.id, text, userId, workspaceId);
      res.json({ _version: 1, annotation: ann });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/only the author/.test(err.message)) {
        return apiError(res, 403, "FORBIDDEN", err.message);
      }
      if (/required/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/annotations/:id
  apiRoute("delete", "/annotations/:id", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      await deleteAnnotation(req.params.id, userId, workspaceId);
      res.status(204).send();
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/only the author/.test(err.message)) {
        return apiError(res, 403, "FORBIDDEN", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/annotations/:id/reply
  apiRoute("post", "/annotations/:id/reply", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const { text } = req.body || {};
      const ann = await replyToAnnotation(req.params.id, { workspaceId, text }, userId);
      res.status(201).json({ _version: 1, annotation: ann });
    } catch (err) {
      if (/parent/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/annotations/:id/react
  apiRoute("post", "/annotations/:id/react", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const { emoji } = req.body || {};
      const result = await addReaction(req.params.id, emoji, userId, workspaceId);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/annotations/:id/resolve
  apiRoute("post", "/annotations/:id/resolve", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const ann = await resolveAnnotation(req.params.id, userId, workspaceId);
      res.json({ _version: 1, annotation: ann });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/annotations/:id/unresolve
  apiRoute("post", "/annotations/:id/unresolve", limiter, async (req, res) => {
    try {
      const workspaceId = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const ann = await unresolveAnnotation(req.params.id, userId, workspaceId);
      res.json({ _version: 1, annotation: ann });
    } catch (err) {
      if (/not found/.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
