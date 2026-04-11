/**
 * Phase 41.3: Presence routes — live collaborator status and cursor positions.
 *
 * GET  /api/v1/presence?workspace=X  — list active sessions in a workspace
 * GET  /api/v1/presence/me           — list my active sessions
 * POST /api/v1/presence/status       — update status for one of my sessions
 */
import { globalPresence, getAvatarColor, getInitials } from "../lib/presence.js";

const VALID_STATUSES = new Set(["active", "idle", "away"]);

function decorateSession(entry) {
  return {
    sessionId: entry.sessionId,
    userId: entry.userId,
    workspace: entry.workspace,
    status: entry.status,
    cursor: entry.cursor || null,
    metadata: entry.metadata || {},
    joinedAt: entry.joinedAt,
    lastSeen: entry.lastSeen,
    avatar: {
      color: getAvatarColor(entry.userId),
      initials: getInitials(
        (entry.metadata && (entry.metadata.displayName || entry.metadata.name)) || entry.userId
      ),
    },
  };
}

export function mountPresenceRoutes(app, deps) {
  const { apiRoute, apiError, sanitizeWorkspace, storageRateLimiter, logRequest } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());
  const log = logRequest || ((req, res, next) => next());

  // GET /api/v1/presence?workspace=X
  apiRoute("get", "/presence", limiter, log, async (req, res) => {
    try {
      const workspace = sanitizeWorkspace(req.query?.workspace || "default");
      const sessions = globalPresence.getPresence(workspace).map(decorateSession);
      // Roll-up: unique users with status priority active > idle > away
      const userMap = new Map();
      const statusRank = { active: 3, idle: 2, away: 1 };
      for (const s of sessions) {
        const existing = userMap.get(s.userId);
        if (!existing || (statusRank[s.status] || 0) > (statusRank[existing.status] || 0)) {
          userMap.set(s.userId, s);
        }
      }
      res.json({
        _version: 1,
        workspace,
        sessions,
        users: Array.from(userMap.values()),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/presence/me — current user's sessions across workspaces
  apiRoute("get", "/presence/me", limiter, log, async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const sessions = globalPresence.getUserSessions(userId).map(decorateSession);
      res.json({ _version: 1, userId, sessions });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/presence/status — update status for a session
  apiRoute("post", "/presence/status", limiter, log, async (req, res) => {
    try {
      const { sessionId, status } = req.body || {};
      if (!sessionId || typeof sessionId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "sessionId is required.");
      }
      if (!VALID_STATUSES.has(status)) {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "status must be one of: active, idle, away."
        );
      }
      const entry = globalPresence.getSession(sessionId);
      if (!entry) {
        return apiError(res, 404, "NOT_FOUND", "Session not found.");
      }
      const userId = req.userId || "anonymous";
      // Only allow a user to update their own session (anonymous can update anonymous).
      if (entry.userId !== userId) {
        return apiError(res, 403, "FORBIDDEN", "You can only update your own session.");
      }
      const updated = globalPresence.updateStatus(sessionId, status);
      res.json({ _version: 1, sessionId, status: updated });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountPresenceRoutes;
