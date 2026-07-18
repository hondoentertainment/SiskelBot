/**
 * POST /api/v1/agent/sessions/:id/resume — resume an agent run from its
 * last checkpoint snapshot.
 *
 * Loads the checkpoint, validates it exists, and returns the restored state
 * so the caller can re-submit to the chat completion endpoint with the
 * recovered messages and agentOpts.resume = true.
 */
import { loadCheckpoint } from "../lib/agent-checkpoint.js";
import { getAgentSession, setAgentSessionStatus } from "../lib/agent-session.js";
import { resolveStorageUserId } from "../lib/teams.js";
import { getWorkspaceAgentAccess } from "../lib/workspace-agent-settings.js";

export function mountAgentResumeRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  apiRoute(
    "post",
    "/agent/sessions/:id/resume",
    logRequest,
    userAuth,
    requireScope("write"),
    async (req, res) => {
      const sessionId = String(req.params.id || "").trim();
      if (!sessionId) {
        return apiError(res, 400, "INVALID_SESSION_ID", "Session id is required", "");
      }

      // Verify session exists and caller has access
      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "Create a session first.");
      }

      const access = await getWorkspaceAgentAccess(req.userId || "anonymous", session.workspace);
      const storageUserId = await resolveStorageUserId(req.userId || "anonymous", session.workspace);
      if (!access.allowed || session.ownerStorageUserId !== storageUserId) {
        return apiError(res, 403, "FORBIDDEN", "Access denied", "");
      }

      // Load checkpoint
      const checkpoint = await loadCheckpoint(sessionId);
      if (!checkpoint) {
        return apiError(
          res,
          404,
          "CHECKPOINT_NOT_FOUND",
          "No checkpoint found for this session",
          "The session has no resumable checkpoint.",
        );
      }

      // Mark session as running again
      await setAgentSessionStatus(sessionId, "running");

      res.json({
        ok: true,
        resumedFromIteration: checkpoint.iteration ?? 0,
        sessionId,
        checkpoint,
        planSummary: session.planSummary || null,
        planDag: session.planDag || checkpoint.upfrontPlanDag || null,
      });
    },
  );
}
