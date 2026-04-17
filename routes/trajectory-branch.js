/**
 * Routes for trajectory branching: fork an agent run from a checkpoint
 * to explore "what if" scenarios.
 *
 * POST /api/v1/agent/sessions/:id/branch  — create a branch
 * GET  /api/v1/agent/sessions/:id/branches — list branches
 */
import { branchFromCheckpoint, listBranches } from "../lib/trajectory-branch.js";
import { getAgentSession } from "../lib/agent-session.js";
import { resolveStorageUserId } from "../lib/teams.js";
import { getWorkspaceAgentAccess } from "../lib/workspace-agent-settings.js";

/**
 * @param {import("express").Express} app
 * @param {object} deps
 */
export function mountTrajectoryBranchRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  // POST /agent/sessions/:id/branch — create a branch from the latest checkpoint.
  apiRoute(
    "post",
    "/agent/sessions/:id/branch",
    logRequest,
    userAuth,
    requireScope("write"),
    async (req, res) => {
      const sessionId = String(req.params.id || "").trim();
      if (!sessionId) {
        return apiError(res, 400, "INVALID_ID", "session id required", "Pass :id in the URL.");
      }
      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "Verify the session id.");
      }
      try {
        const access = await getWorkspaceAgentAccess(req.userId || "anonymous", session.workspace);
        if (!access.allowed) {
          return apiError(res, 403, "FORBIDDEN", "Workspace access denied", "Join the workspace.");
        }
        const storageUserId = await resolveStorageUserId(req.userId || "anonymous", session.workspace);
        if (session.ownerStorageUserId !== storageUserId) {
          return apiError(res, 403, "FORBIDDEN", "Not the session owner", "Only the owner can branch.");
        }

        const iteration = req.body?.iteration !== undefined ? Number(req.body.iteration) : undefined;

        const result = await branchFromCheckpoint({
          sessionId,
          iteration,
          workspace: session.workspace,
          userId: storageUserId,
        });

        return res.status(201).json({
          branchSessionId: result.branchSessionId,
          iteration: result.iteration,
          resumeUrl: `/api/v1/agent/sessions/${result.branchSessionId}/resume`,
        });
      } catch (err) {
        const code = err?.code;
        if (code === "CHECKPOINT_NOT_FOUND") {
          return apiError(res, 404, "CHECKPOINT_NOT_FOUND", err.message, "Run the agent first to create a checkpoint.");
        }
        if (code === "ITERATION_MISMATCH") {
          return apiError(res, 400, "ITERATION_MISMATCH", err.message, "Only the latest checkpoint iteration is supported.");
        }
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Branch failed", "See server logs.");
      }
    },
  );

  // GET /agent/sessions/:id/branches — list branches of a session.
  apiRoute(
    "get",
    "/agent/sessions/:id/branches",
    logRequest,
    userAuth,
    requireScope("read"),
    async (req, res) => {
      const sessionId = String(req.params.id || "").trim();
      if (!sessionId) {
        return apiError(res, 400, "INVALID_ID", "session id required", "Pass :id in the URL.");
      }
      const session = await getAgentSession(sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "Session not found", "Verify the session id.");
      }
      try {
        const access = await getWorkspaceAgentAccess(req.userId || "anonymous", session.workspace);
        if (!access.allowed) {
          return apiError(res, 403, "FORBIDDEN", "Workspace access denied", "Join the workspace.");
        }
        const storageUserId = await resolveStorageUserId(req.userId || "anonymous", session.workspace);
        if (session.ownerStorageUserId !== storageUserId) {
          return apiError(res, 403, "FORBIDDEN", "Not the session owner", "Only the owner can list branches.");
        }
        const branches = await listBranches(sessionId);
        return res.json({ branches });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List branches failed", "See server logs.");
      }
    },
  );
}

export default mountTrajectoryBranchRoutes;
