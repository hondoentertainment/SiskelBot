// Agent Run SSE stream — 4-pane (Plan / Timeline / Artifacts / Approvals) feed.
// Follows the same deps/apiRoute/userAuth/requireScope pattern as
// routes/agent-sessions.js. The stream itself is implemented in
// lib/agent-run-stream.js; this route only handles auth, workspace access,
// and response lifecycle.

import { agentSessionApiEnabled, getAgentSession } from "../lib/agent-session.js";
import { resolveStorageUserId } from "../lib/teams.js";
import { getWorkspaceAgentAccess } from "../lib/workspace-agent-settings.js";
import { streamAgentRun } from "../lib/agent-run-stream.js";

export function mountAgentRunStreamRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  apiRoute(
    "get",
    "/agent/sessions/:sessionId/stream",
    logRequest,
    userAuth,
    requireScope("read"),
    async (req, res) => {
      if (!agentSessionApiEnabled()) {
        return apiError(
          res,
          503,
          "FEATURE_DISABLED",
          "Agent sessions API disabled",
          "Enable sessions API first (unset AGENT_SESSION_API=0).",
        );
      }

      const sessionId = String(req.params.sessionId || "").trim();
      if (!sessionId) {
        return apiError(res, 400, "INVALID", "sessionId required", "");
      }

      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "Check the session id.");
      }

      try {
        const access = await getWorkspaceAgentAccess(req.userId || "anonymous", session.workspace);
        if (!access.allowed) {
          return apiError(res, 403, "FORBIDDEN", "Access denied", "Join the workspace first.");
        }
        const storageUserId = await resolveStorageUserId(req.userId || "anonymous", session.workspace);
        if (session.ownerStorageUserId !== storageUserId) {
          return apiError(
            res,
            403,
            "FORBIDDEN",
            "Session belongs to another user",
            "Only the owner can stream this session.",
          );
        }
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Access check failed", "See server logs.");
      }

      try {
        await streamAgentRun({
          sessionId,
          workspace: session.workspace,
          userId: req.userId,
          res,
          req,
        });
      } catch (err) {
        // Headers may already be flushed; best-effort JSON error, then close.
        if (!res.headersSent) {
          return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Stream failed", "See server logs.");
        }
        try { res.end(); } catch (_) {}
      }
    },
  );
}

export default mountAgentRunStreamRoutes;
