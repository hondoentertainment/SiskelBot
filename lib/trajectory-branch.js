/**
 * Trajectory branching: fork an agent run from a checkpoint to explore
 * "what if" scenarios. Creates a child session with a copy of the
 * checkpoint so the caller can resume with different parameters.
 */
import { loadCheckpoint, saveCheckpoint } from "./agent-checkpoint.js";
import { createAgentSession, getSessionChildren } from "./agent-session.js";

/**
 * Branch from a session's latest checkpoint.
 *
 * Loads the checkpoint for `sessionId`. If `iteration` is specified and
 * differs from the checkpoint's iteration, rejects (only branching from
 * the latest checkpoint is supported). Creates a new child session and
 * copies the checkpoint to it.
 *
 * @param {{ sessionId: string, iteration?: number, workspace: string, userId: string }} opts
 * @returns {Promise<{ branchSessionId: string, checkpoint: object, iteration: number }>}
 */
export async function branchFromCheckpoint({ sessionId, iteration, workspace, userId }) {
  const sid = String(sessionId || "").trim();
  if (!sid) {
    const err = new Error("sessionId is required");
    err.code = "INVALID_SESSION_ID";
    throw err;
  }

  const checkpoint = await loadCheckpoint(sid);
  if (!checkpoint) {
    const err = new Error("No checkpoint found for session");
    err.code = "CHECKPOINT_NOT_FOUND";
    throw err;
  }

  const cpIteration = typeof checkpoint.iteration === "number" ? checkpoint.iteration : 0;

  if (iteration !== undefined && iteration !== null) {
    const requested = Number(iteration);
    if (!Number.isFinite(requested) || requested !== cpIteration) {
      const err = new Error(
        `Requested iteration ${requested} does not match latest checkpoint iteration ${cpIteration}; only branching from the latest checkpoint is supported`,
      );
      err.code = "ITERATION_MISMATCH";
      throw err;
    }
  }

  const title = `Branch from iteration ${cpIteration}`;
  const childSession = await createAgentSession({
    workspace: workspace || "default",
    ownerStorageUserId: userId || "anonymous",
    title,
    parentSessionId: sid,
  });

  const branchCheckpoint = {
    ...checkpoint,
    sessionId: childSession.id,
    timestamp: Date.now(),
  };
  await saveCheckpoint(childSession.id, branchCheckpoint);

  return {
    branchSessionId: childSession.id,
    checkpoint: branchCheckpoint,
    iteration: cpIteration,
  };
}

/**
 * List branches (child sessions) of a session that were created via
 * branchFromCheckpoint (title starts with "Branch from").
 *
 * @param {string} sessionId
 * @returns {Promise<Array<{ branchSessionId: string, branchedAtIteration: number, createdAt: string, status: string }>>}
 */
export async function listBranches(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return [];

  const children = await getSessionChildren(sid);
  return children
    .filter((child) => typeof child.title === "string" && child.title.startsWith("Branch from"))
    .map((child) => {
      const match = child.title.match(/^Branch from iteration (\d+)/);
      const branchedAtIteration = match ? Number(match[1]) : 0;
      return {
        branchSessionId: child.id,
        branchedAtIteration,
        createdAt: child.createdAt,
        status: child.status,
      };
    });
}
