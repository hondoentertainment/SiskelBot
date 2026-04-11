/**
 * Phase 47.5: Long-running mission runner.
 * Background worker that drives running missions, takes periodic checkpoints,
 * enforces constraints, and emits state-change notifications.
 */
import {
  getMission,
  createCheckpoint,
  checkConstraints,
  abortMission,
  failMission,
  completeMission,
  updateProgress,
  incrementCounters,
  appendConversationMessage,
  listMissions,
  _internals,
} from "./long-running-missions.js";

const POLL_INTERVAL_MS = 30 * 1000; // worker tick
const MAX_ITERATIONS_PER_TICK = 5;
const activeRuns = new Map(); // missionId -> { lastCheckpointAt, lastIterationAt }
let workerHandle = null;
let workerStopped = false;

function emit(notify, event, payload) {
  try {
    if (typeof notify === "function") notify(event, payload);
  } catch (_) {}
}

/**
 * Run one iteration of agent work for a mission.
 * Pluggable executor: opts.iterate(mission) -> { progress?, currentStep?, toolCalls?, costUsd?, message?, done?, error? }
 */
async function runOneIteration(mission, opts) {
  if (typeof opts.iterate !== "function") {
    // Default: simulate work by advancing progress slowly so the loop has shape.
    const next = Math.min(1, (mission.progress || 0) + 0.1);
    return {
      progress: next,
      currentStep: `Iteration ${mission.iterationsCount + 1}`,
      toolCalls: 0,
      costUsd: 0,
      done: next >= 1,
    };
  }
  return opts.iterate(mission);
}

/**
 * Main execution loop for a single mission.
 * @param {string} missionId
 * @param {object} [opts] - { iterate, notify, maxIterations, backendFetch }
 */
export async function runMission(missionId, opts = {}) {
  const notify = opts.notify;
  let mission = await getMission(missionId);
  if (!mission) {
    return { ok: false, error: "Mission not found" };
  }
  if (mission.status !== "running" && mission.status !== "pending") {
    return { ok: false, error: `Mission is ${mission.status}; cannot run` };
  }

  // Ensure mission is marked as running
  if (mission.status === "pending") {
    mission.status = "running";
    mission.startedAt = mission.startedAt || new Date().toISOString();
    await _internals.saveMission(mission);
  }

  emit(notify, "mission.started", { missionId });

  const checkpointInterval = mission.checkpointIntervalMs || 5 * 60 * 1000;
  const maxIterations = Number(opts.maxIterations) || MAX_ITERATIONS_PER_TICK;
  let iterations = 0;
  let lastCheckpointTs = mission.lastCheckpointAt
    ? new Date(mission.lastCheckpointAt).getTime()
    : 0;

  try {
    while (iterations < maxIterations) {
      // Reload latest state in case of external pause/abort
      mission = await getMission(missionId);
      if (!mission) return { ok: false, error: "Mission disappeared" };
      if (mission.status === "paused") {
        emit(notify, "mission.paused", { missionId });
        return { ok: true, paused: true };
      }
      if (mission.status === "aborted" || mission.status === "failed" || mission.status === "completed") {
        emit(notify, "mission.terminal", { missionId, status: mission.status });
        return { ok: true, terminal: true, status: mission.status };
      }

      // Constraint check
      const constraintResult = checkConstraints(mission);
      if (!constraintResult.withinLimits) {
        await abortMission(missionId, `Constraints violated: ${constraintResult.violations.join("; ")}`);
        emit(notify, "mission.aborted", { missionId, reason: "constraints" });
        return { ok: false, aborted: true, violations: constraintResult.violations };
      }

      // Run one iteration
      let result;
      try {
        result = await runOneIteration(mission, opts);
      } catch (err) {
        await failMission(missionId, err.message || "iteration error");
        emit(notify, "mission.failed", { missionId, error: err.message });
        return { ok: false, failed: true, error: err.message };
      }

      // Apply result
      await incrementCounters(missionId, {
        iterations: 1,
        toolCalls: Number(result?.toolCalls) || 0,
        costUsd: Number(result?.costUsd) || 0,
      });
      if (result && (typeof result.progress === "number" || result.currentStep)) {
        await updateProgress(missionId, {
          value: typeof result.progress === "number" ? result.progress : undefined,
          currentStep: result.currentStep,
        });
      }
      if (result?.message) {
        await appendConversationMessage(missionId, {
          role: result.message.role || "assistant",
          content: result.message.content || String(result.message),
        });
      }

      iterations += 1;

      // Periodic checkpoint
      const now = Date.now();
      if (!lastCheckpointTs || now - lastCheckpointTs >= checkpointInterval) {
        await createCheckpoint(missionId);
        lastCheckpointTs = now;
        emit(notify, "mission.checkpoint", { missionId });
      }

      if (result?.done) {
        await createCheckpoint(missionId);
        await completeMission(missionId, result.result || {});
        emit(notify, "mission.completed", { missionId });
        return { ok: true, completed: true, iterations };
      }

      if (result?.error) {
        await failMission(missionId, result.error);
        emit(notify, "mission.failed", { missionId, error: result.error });
        return { ok: false, failed: true, error: result.error };
      }
    }

    // Out of iterations for this tick — make sure we have an up-to-date checkpoint
    if (Date.now() - lastCheckpointTs >= checkpointInterval / 2) {
      await createCheckpoint(missionId);
    }
    return { ok: true, paused: false, iterations };
  } finally {
    activeRuns.set(missionId, {
      lastIterationAt: Date.now(),
      lastCheckpointAt: lastCheckpointTs,
    });
  }
}

/**
 * Iterate over all running missions in all workspaces and advance them.
 * @param {object} opts
 */
export async function tickAllMissions(opts = {}) {
  const workspaces = opts.workspaces || ["default"];
  const results = [];
  for (const ws of workspaces) {
    const missions = await listMissions(ws, "running");
    for (const m of missions) {
      const r = await runMission(m.missionId, opts);
      results.push({ missionId: m.missionId, ...r });
    }
  }
  return results;
}

/**
 * Start the background worker. The worker periodically advances all running missions.
 * @param {object} opts - { intervalMs, workspaces, iterate, notify }
 */
export function startMissionWorker(opts = {}) {
  if (workerHandle) return { started: false, reason: "already-running" };
  workerStopped = false;
  const intervalMs = Number(opts.intervalMs) || POLL_INTERVAL_MS;

  const tick = async () => {
    if (workerStopped) return;
    try {
      await tickAllMissions(opts);
    } catch (err) {
      console.error("[mission-runner] worker tick failed:", err.message);
    }
  };

  workerHandle = setInterval(tick, intervalMs);
  if (typeof workerHandle.unref === "function") workerHandle.unref();
  // Kick off an immediate tick
  setImmediate(tick);
  return { started: true, intervalMs };
}

/**
 * Stop the background worker.
 */
export function stopMissionWorker() {
  workerStopped = true;
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
    return { stopped: true };
  }
  return { stopped: false };
}

/**
 * Inspect active runs (debug helper).
 */
export function getActiveRuns() {
  return Array.from(activeRuns.entries()).map(([id, info]) => ({ missionId: id, ...info }));
}

export const _runnerInternals = {
  POLL_INTERVAL_MS,
  MAX_ITERATIONS_PER_TICK,
  runOneIteration,
};
