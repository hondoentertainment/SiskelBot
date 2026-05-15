/**
 * Agent checkpoint store: save / load / delete per-session checkpoints so
 * agent runs can be resumed from the last good iteration after crashes,
 * timeouts, or manual pauses.
 *
 * Stores one checkpoint per session under data/agent-checkpoints/<sessionId>.json
 * via lib/json-path-store.js (respects STORAGE_BACKEND).
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

const CHECKPOINT_VERSION = 1;

function checkpointPath(sessionId) {
  return join(getDataDir(), "agent-checkpoints", `${sessionId}.json`);
}

/**
 * Persist a checkpoint for the given session. Overwrites any previous
 * checkpoint (cap: 1 per session).
 *
 * @param {string} sessionId
 * @param {{
 *   sessionId: string,
 *   iteration: number,
 *   messages: object[],
 *   toolResults?: object[],
 *   costAccumulator?: { totalUsd: number, tokens: object },
 *   runId: string,
 *   model: string,
 *   timestamp: number,
 *   version?: number,
 *   upfrontPlanDag?: object,
 * }} checkpoint
 */
export async function saveCheckpoint(sessionId, checkpoint) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  const data = {
    ...checkpoint,
    sessionId: id,
    version: checkpoint.version ?? CHECKPOINT_VERSION,
    timestamp: checkpoint.timestamp ?? Date.now(),
  };
  await writeJsonPath(checkpointPath(id), data);
}

/**
 * Load the most recent checkpoint for a session.
 *
 * @param {string} sessionId
 * @returns {Promise<object | null>} checkpoint or null if none exists
 */
export async function loadCheckpoint(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const data = await readJsonPath(checkpointPath(id), null);
  if (!data || typeof data !== "object" || !data.sessionId) return null;
  return data;
}

/**
 * Delete the checkpoint for a session.
 *
 * @param {string} sessionId
 */
export async function deleteCheckpoint(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  // Overwrite with an empty object — json-path-store always writes, and
  // loadCheckpoint treats missing sessionId as "no checkpoint".
  await writeJsonPath(checkpointPath(id), {});
}
