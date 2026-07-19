/**
 * Honest advice companion (Daimon-style advice app functionality).
 *
 * POST   /api/v1/advice/enable
 * POST   /api/v1/advice/disable
 * GET    /api/v1/advice/status
 * POST   /api/v1/advice/thoughts
 * GET    /api/v1/advice/thoughts
 * PATCH  /api/v1/advice/thoughts/:id
 * GET    /api/v1/advice/resurface
 * DELETE /api/v1/advice/thoughts/:id
 * GET    /api/v1/advice/prompt
 */
import {
  enableAdviceMode,
  disableAdviceMode,
  getAdviceModeStatus,
  captureThought,
  listThoughts,
  resurfaceThoughts,
  deleteThought,
  updateThought,
  buildAdviceSystemPrompt,
} from "../lib/advice-companion.js";
import { resolveStorageUserId } from "../lib/teams.js";

export function mountAdviceRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    sanitizeWorkspace,
    storageRateLimiter,
  } = deps;
  const limiter = storageRateLimiter || ((_r, _s, n) => n());

  apiRoute("get", "/advice/prompt", limiter, userAuth, logRequest, (req, res) => {
    const challenge = req.query?.challenge === "1" || req.query?.challenge === "true";
    res.json({
      systemPrompt: buildAdviceSystemPrompt({ challenge }),
      challenge,
    });
  });

  apiRoute("get", "/advice/status", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
      const status = await getAdviceModeStatus(storageUserId, workspace);
      res.json(status);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/advice/enable", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
      const result = await enableAdviceMode(storageUserId, workspace, {
        challenge: req.body?.challenge === true || req.body?.challenge === "1",
        mergeExisting: req.body?.mergeExisting !== false,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/advice/disable", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", workspace);
      const result = await disableAdviceMode(storageUserId, workspace);
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/advice/thoughts", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace);
      const userId = req.userId || "anonymous";
      const thought = await captureThought(userId, workspace, {
        content: req.body?.content,
        kind: req.body?.kind,
        importance: req.body?.importance,
        resurfaceAt: req.body?.resurfaceAt,
        tags: req.body?.tags,
      });
      res.status(201).json({ thought });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/advice/thoughts", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const result = await listThoughts(userId, workspace, {
        limit: Number(req.query?.limit) || 50,
        thoughtKind: req.query?.kind,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("patch", "/advice/thoughts/:id", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace);
      const userId = req.userId || "anonymous";
      const result = await updateThought(userId, workspace, req.params.id, {
        content: req.body?.content,
        kind: req.body?.kind,
        importance: req.body?.importance,
        resurfaceAt: req.body?.resurfaceAt,
        tags: req.body?.tags,
      });
      if (!result.ok) {
        const status = /not found/i.test(result.error || "") ? 404 : 400;
        return apiError(res, status, status === 404 ? "NOT_FOUND" : "INVALID_INPUT", result.error);
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/advice/resurface", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace);
      const userId = req.userId || "anonymous";
      const result = await resurfaceThoughts(userId, workspace, {
        limit: Number(req.query?.limit) || 8,
        query: req.query?.q,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/advice/thoughts/:id", limiter, userAuth, logRequest, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace || req.body?.workspace);
      const userId = req.userId || "anonymous";
      const result = await deleteThought(userId, workspace, req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", result.error || "Thought not found");
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
