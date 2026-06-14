/**
 * Collaboration API routes — active collaborators, activity feed.
 *
 * GET  /api/v1/workspaces/:id/collaborators  — list active collaborators
 * GET  /api/v1/workspaces/:id/activity        — recent activity feed
 * POST /api/v1/workspaces/:id/activity        — record an activity entry
 */
import {
  createCollaborationSession,
  getActiveCollaborators,
} from "../lib/collaboration.js";

export function mountCollaborationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
    getOnlineUsers,
  } = deps;

  // GET /api/v1/workspaces/:id/collaborators
  apiRoute(
    "get",
    "/workspaces/:id/collaborators",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const onlineUsers = getOnlineUsers(workspaceId);
        const collaborators = getActiveCollaborators(workspaceId, onlineUsers);
        res.json({ _version: 1, workspaceId, items: collaborators });
      } catch (err) {
        console.error("Collaborators list error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  // GET /api/v1/workspaces/:id/activity
  apiRoute(
    "get",
    "/workspaces/:id/activity",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const session = createCollaborationSession(workspaceId);
        const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
        const items = session.getRecentActivity(limit);
        res.json({ _version: 1, workspaceId, items });
      } catch (err) {
        console.error("Activity feed error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  // POST /api/v1/workspaces/:id/activity
  apiRoute(
    "post",
    "/workspaces/:id/activity",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.params.id);
        const action = typeof req.body?.action === "string" ? req.body.action.trim().slice(0, 200) : null;
        if (!action) {
          return apiError(res, 400, "VALIDATION_ERROR", "action is required", "Provide an action string.");
        }
        const details = req.body?.details || null;
        const session = createCollaborationSession(workspaceId);
        const entry = session.recordActivity(req.userId || "anonymous", action, details);
        res.status(201).json(entry);
      } catch (err) {
        console.error("Record activity error:", err.message);
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );
}
