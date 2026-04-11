/**
 * Continuous learning curation worker.
 * Periodically scores accumulated interactions, promotes high-quality ones to
 * training candidates and demotes low-quality ones to the rejected pool.
 */
import {
  curateTrainingData,
  proposeTrainingRun,
  updateCurationState,
  markInteractionsCurated,
  markInteractionsRejected,
} from "./continuous-learning.js";

const DEFAULT_INTERVAL_MS = Number(process.env.CL_CURATION_INTERVAL_MS) || 60 * 60 * 1000;

let timer = null;
let running = false;

/**
 * Run a single curation cycle for one workspace.
 * @param {string} workspaceId
 */
export async function runCurationCycle(workspaceId) {
  const curated = await curateTrainingData(workspaceId, {
    minScore: Number(process.env.CL_TRAIN_MIN_SCORE) || 0.6,
    maxExamples: Number(process.env.CL_MAX_EXAMPLES) || 1000,
    deduplicate: true,
    balance: false,
  });

  const acceptedIds = (curated.candidates || []).map((c) => c.id);
  const rejectedIds = (curated.rejectedSamples || []).map((c) => c.id);

  if (acceptedIds.length) await markInteractionsCurated(workspaceId, acceptedIds);
  if (rejectedIds.length) await markInteractionsRejected(workspaceId, rejectedIds);

  const proposal = await proposeTrainingRun(workspaceId);

  await updateCurationState(workspaceId, {
    lastCuratedAt: new Date().toISOString(),
    lastTrainingCandidateCount: curated.count,
  });

  return {
    workspaceId,
    curated: curated.count,
    rejected: rejectedIds.length,
    proposal,
  };
}

/**
 * Run curation cycles for every workspace that has a continuous-learning directory.
 */
export async function runCurationForAllWorkspaces() {
  if (running) return { skipped: true, reason: "already running" };
  running = true;
  try {
    const workspaces = await discoverWorkspaces();
    const results = [];
    for (const ws of workspaces) {
      try {
        const result = await runCurationCycle(ws);
        results.push(result);
      } catch (e) {
        console.warn(`[continuous-learning] Curation failed for ${ws}:`, e.message);
      }
    }
    return { results, count: results.length };
  } finally {
    running = false;
  }
}

async function discoverWorkspaces() {
  const { readdirSync, existsSync } = await import("fs");
  const { join } = await import("path");
  const base = join(process.env.STORAGE_PATH || join(process.cwd(), "data"), "continuous-learning");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * Start a periodic curation worker. Idempotent — calling twice replaces the timer.
 * @param {number} [intervalMs]
 */
export function startCurationWorker(intervalMs = DEFAULT_INTERVAL_MS) {
  stopCurationWorker();
  const ms = Math.max(1000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
  timer = setInterval(() => {
    runCurationForAllWorkspaces().catch((e) => {
      console.warn("[continuous-learning] Worker cycle failed:", e.message);
    });
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  return { started: true, intervalMs: ms };
}

export function stopCurationWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    return { stopped: true };
  }
  return { stopped: false };
}

export function isCurationWorkerRunning() {
  return timer !== null;
}
