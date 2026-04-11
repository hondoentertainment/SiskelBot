/**
 * Phase 47.5: Long-running missions.
 * Agents that work autonomously for extended periods (hours/days)
 * with checkpointing, pause/resume, and constraint enforcement.
 *
 * Storage layout:
 *   data/missions/{workspaceId}.json                       - mission index
 *   data/missions/{missionId}/mission.json                 - mission state
 *   data/missions/{missionId}/checkpoints/{timestamp}.json - state snapshots
 *   data/missions/{missionId}/history.json                 - event history
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const MAX_MISSIONS_PER_WORKSPACE = 200;
const MAX_CHECKPOINTS_PER_MISSION = 200;
const MAX_HISTORY_EVENTS = 1000;
const DEFAULT_MAX_DURATION_HOURS = 24;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_TOOL_CALLS = 5000;
const DEFAULT_MAX_COST_USD = 100;

const VALID_STATUSES = new Set([
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "aborted",
]);

function sanitizeId(id) {
  if (typeof id !== "string" || !id.trim()) return null;
  return id.trim().slice(0, 100).replace(/[^a-zA-Z0-9._-]/g, "");
}

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !ws.trim()) return "default";
  return ws.trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function indexPath(workspaceId) {
  return join(getDataDir(), "missions", sanitizeWorkspace(workspaceId) + ".json");
}

function missionDir(missionId) {
  return join(getDataDir(), "missions", sanitizeId(missionId));
}

function missionStatePath(missionId) {
  return join(missionDir(missionId), "mission.json");
}

function checkpointDir(missionId) {
  return join(missionDir(missionId), "checkpoints");
}

function checkpointPath(missionId, checkpointId) {
  return join(checkpointDir(missionId), sanitizeId(checkpointId) + ".json");
}

function historyPath(missionId) {
  return join(missionDir(missionId), "history.json");
}

function normalizeIndex(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.missions)) return raw;
  return { missions: [] };
}

function normalizeHistory(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.events)) return raw;
  return { events: [] };
}

async function appendHistory(missionId, event) {
  const path = historyPath(missionId);
  await withPathLock(path, async () => {
    const data = normalizeHistory(await readJsonPath(path, null));
    data.events.push({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    });
    if (data.events.length > MAX_HISTORY_EVENTS) {
      data.events = data.events.slice(-MAX_HISTORY_EVENTS);
    }
    await writeJsonPath(path, data);
  });
}

async function updateIndexEntry(workspaceId, mission) {
  const path = indexPath(workspaceId);
  await withPathLock(path, async () => {
    const data = normalizeIndex(await readJsonPath(path, null));
    const idx = data.missions.findIndex((m) => m.missionId === mission.missionId);
    const summary = {
      missionId: mission.missionId,
      name: mission.name,
      status: mission.status,
      progress: mission.progress,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      startedAt: mission.startedAt || null,
      completedAt: mission.completedAt || null,
    };
    if (idx === -1) {
      if (data.missions.length >= MAX_MISSIONS_PER_WORKSPACE) {
        throw new Error("Maximum number of missions reached for this workspace");
      }
      data.missions.push(summary);
    } else {
      data.missions[idx] = summary;
    }
    await writeJsonPath(path, data);
  });
}

async function removeIndexEntry(workspaceId, missionId) {
  const path = indexPath(workspaceId);
  await withPathLock(path, async () => {
    const data = normalizeIndex(await readJsonPath(path, null));
    const before = data.missions.length;
    data.missions = data.missions.filter((m) => m.missionId !== missionId);
    if (data.missions.length !== before) {
      await writeJsonPath(path, data);
    }
  });
}

async function loadMission(missionId) {
  const id = sanitizeId(missionId);
  if (!id) return null;
  const data = await readJsonPath(missionStatePath(id), null);
  if (!data || typeof data !== "object" || !data.missionId) return null;
  return data;
}

async function saveMission(mission) {
  mission.updatedAt = new Date().toISOString();
  await writeJsonPath(missionStatePath(mission.missionId), mission);
  await updateIndexEntry(mission.workspaceId, mission);
}

/**
 * Create a new mission.
 * @param {{
 *   workspaceId?: string,
 *   name: string,
 *   goal: string,
 *   maxDurationHours?: number,
 *   checkpointIntervalMs?: number,
 *   agentConfig?: object,
 *   notifyOnComplete?: boolean,
 *   constraints?: { maxToolCalls?: number, maxCostUsd?: number }
 * }} config
 * @returns {Promise<{ missionId: string, status: string }>}
 */
export async function createMission(config = {}) {
  if (!config.name || typeof config.name !== "string") {
    throw new Error("name is required");
  }
  if (!config.goal || typeof config.goal !== "string") {
    throw new Error("goal is required");
  }

  const workspaceId = sanitizeWorkspace(config.workspaceId);
  const missionId = randomUUID();
  const now = new Date().toISOString();

  const mission = {
    missionId,
    workspaceId,
    name: config.name.trim().slice(0, 200),
    goal: config.goal.trim().slice(0, 5000),
    status: "pending",
    progress: 0,
    currentStep: "Created",
    maxDurationHours: Number(config.maxDurationHours) > 0
      ? Number(config.maxDurationHours)
      : DEFAULT_MAX_DURATION_HOURS,
    checkpointIntervalMs: Number(config.checkpointIntervalMs) > 0
      ? Number(config.checkpointIntervalMs)
      : DEFAULT_CHECKPOINT_INTERVAL_MS,
    agentConfig: config.agentConfig && typeof config.agentConfig === "object"
      ? config.agentConfig
      : {},
    notifyOnComplete: !!config.notifyOnComplete,
    constraints: {
      maxToolCalls: Number(config.constraints?.maxToolCalls) > 0
        ? Number(config.constraints.maxToolCalls)
        : DEFAULT_MAX_TOOL_CALLS,
      maxCostUsd: Number(config.constraints?.maxCostUsd) > 0
        ? Number(config.constraints.maxCostUsd)
        : DEFAULT_MAX_COST_USD,
    },
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    pausedAt: null,
    abortReason: null,
    failureReason: null,
    iterationsCount: 0,
    toolCallsCount: 0,
    costUsd: 0,
    checkpoints: [],
    milestones: [],
    lastCheckpointAt: null,
    lastError: null,
    conversationHistory: [],
    artifacts: [],
  };

  ensureDir(checkpointDir(missionId));
  await saveMission(mission);
  await appendHistory(missionId, { type: "created", message: `Mission "${mission.name}" created` });

  return { missionId, status: mission.status };
}

/**
 * Begin execution of a mission. Transitions from pending → running.
 * @param {string} missionId
 * @returns {Promise<{ started: boolean, firstCheckpoint?: object }>}
 */
export async function startMission(missionId) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  if (mission.status === "running") {
    return { started: true };
  }
  if (mission.status !== "pending" && mission.status !== "paused") {
    throw new Error(`Cannot start mission in state: ${mission.status}`);
  }

  mission.status = "running";
  mission.startedAt = mission.startedAt || new Date().toISOString();
  mission.pausedAt = null;
  mission.currentStep = "Initializing";
  await saveMission(mission);
  await appendHistory(missionId, { type: "started", message: "Mission started" });

  // Take an initial checkpoint
  const checkpoint = await createCheckpoint(missionId);
  return { started: true, firstCheckpoint: checkpoint };
}

/**
 * Pause a running mission.
 * @param {string} missionId
 * @param {string} [reason]
 */
export async function pauseMission(missionId, reason = "manual") {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  if (mission.status !== "running") {
    throw new Error(`Cannot pause mission in state: ${mission.status}`);
  }
  mission.status = "paused";
  mission.pausedAt = new Date().toISOString();
  mission.currentStep = `Paused: ${reason}`;
  await saveMission(mission);
  await appendHistory(missionId, { type: "paused", message: `Paused: ${reason}` });
  return { paused: true, reason };
}

/**
 * Resume a paused mission.
 * @param {string} missionId
 */
export async function resumeMission(missionId) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  if (mission.status !== "paused") {
    throw new Error(`Cannot resume mission in state: ${mission.status}`);
  }
  mission.status = "running";
  mission.pausedAt = null;
  mission.currentStep = "Resumed";
  await saveMission(mission);
  await appendHistory(missionId, { type: "resumed", message: "Mission resumed" });
  return { resumed: true };
}

/**
 * Abort a mission. Terminal state.
 * @param {string} missionId
 * @param {string} [reason]
 */
export async function abortMission(missionId, reason = "manual") {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  if (mission.status === "completed" || mission.status === "aborted" || mission.status === "failed") {
    return { aborted: false, alreadyTerminal: true };
  }
  mission.status = "aborted";
  mission.abortReason = reason;
  mission.completedAt = new Date().toISOString();
  mission.currentStep = `Aborted: ${reason}`;
  await saveMission(mission);
  await appendHistory(missionId, { type: "aborted", message: `Aborted: ${reason}` });
  return { aborted: true, reason };
}

/**
 * Mark a mission as completed successfully.
 * @param {string} missionId
 * @param {object} [result]
 */
export async function completeMission(missionId, result = {}) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  mission.status = "completed";
  mission.completedAt = new Date().toISOString();
  mission.progress = 1;
  mission.currentStep = "Completed";
  if (result && typeof result === "object") {
    mission.result = result;
  }
  await saveMission(mission);
  await appendHistory(missionId, { type: "completed", message: "Mission completed", result });
  return { completed: true };
}

/**
 * Mark a mission as failed.
 * @param {string} missionId
 * @param {string} reason
 */
export async function failMission(missionId, reason) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  mission.status = "failed";
  mission.failureReason = reason;
  mission.completedAt = new Date().toISOString();
  mission.currentStep = `Failed: ${reason}`;
  await saveMission(mission);
  await appendHistory(missionId, { type: "failed", message: `Failed: ${reason}` });
  return { failed: true, reason };
}

/**
 * Create a checkpoint of the current mission state.
 * @param {string} missionId
 * @returns {Promise<{ checkpointId: string, savedAt: string }>}
 */
export async function createCheckpoint(missionId) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");

  const checkpointId = `cp-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const savedAt = new Date().toISOString();

  const snapshot = {
    checkpointId,
    missionId: mission.missionId,
    savedAt,
    status: mission.status,
    progress: mission.progress,
    currentStep: mission.currentStep,
    iterationsCount: mission.iterationsCount,
    toolCallsCount: mission.toolCallsCount,
    costUsd: mission.costUsd,
    conversationHistory: Array.isArray(mission.conversationHistory)
      ? mission.conversationHistory.slice()
      : [],
    artifacts: Array.isArray(mission.artifacts) ? mission.artifacts.slice() : [],
    milestones: Array.isArray(mission.milestones) ? mission.milestones.slice() : [],
  };

  ensureDir(checkpointDir(missionId));
  await writeJsonPath(checkpointPath(missionId, checkpointId), snapshot);

  mission.checkpoints = Array.isArray(mission.checkpoints) ? mission.checkpoints : [];
  mission.checkpoints.push({ checkpointId, savedAt });
  if (mission.checkpoints.length > MAX_CHECKPOINTS_PER_MISSION) {
    const removed = mission.checkpoints.shift();
    try {
      const oldPath = checkpointPath(missionId, removed.checkpointId);
      if (existsSync(oldPath)) rmSync(oldPath, { force: true });
    } catch (_) {}
  }
  mission.lastCheckpointAt = savedAt;
  await saveMission(mission);
  await appendHistory(missionId, { type: "checkpoint", message: `Checkpoint ${checkpointId} saved`, checkpointId });

  return { checkpointId, savedAt };
}

/**
 * List all checkpoints for a mission (newest first).
 * @param {string} missionId
 */
export async function listCheckpoints(missionId) {
  const mission = await loadMission(missionId);
  if (!mission) return [];
  const list = Array.isArray(mission.checkpoints) ? mission.checkpoints.slice() : [];
  return list.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
}

/**
 * Restore mission state from a checkpoint.
 * @param {string} missionId
 * @param {string} checkpointId
 */
export async function restoreFromCheckpoint(missionId, checkpointId) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  const cleanCp = sanitizeId(checkpointId);
  if (!cleanCp) throw new Error("Invalid checkpoint id");

  const snapshot = await readJsonPath(checkpointPath(missionId, cleanCp), null);
  if (!snapshot || snapshot.missionId !== mission.missionId) {
    throw new Error("Checkpoint not found");
  }

  mission.progress = snapshot.progress ?? mission.progress;
  mission.currentStep = snapshot.currentStep || mission.currentStep;
  mission.iterationsCount = snapshot.iterationsCount ?? mission.iterationsCount;
  mission.toolCallsCount = snapshot.toolCallsCount ?? mission.toolCallsCount;
  mission.costUsd = snapshot.costUsd ?? mission.costUsd;
  mission.conversationHistory = Array.isArray(snapshot.conversationHistory)
    ? snapshot.conversationHistory.slice()
    : [];
  mission.artifacts = Array.isArray(snapshot.artifacts) ? snapshot.artifacts.slice() : [];
  mission.milestones = Array.isArray(snapshot.milestones) ? snapshot.milestones.slice() : [];
  // Restoration leaves the mission paused so the caller can decide when to resume
  if (mission.status !== "completed" && mission.status !== "aborted" && mission.status !== "failed") {
    mission.status = "paused";
    mission.pausedAt = new Date().toISOString();
  }

  await saveMission(mission);
  await appendHistory(missionId, { type: "restored", message: `Restored from ${cleanCp}`, checkpointId: cleanCp });

  return { restored: true, checkpointId: cleanCp };
}

/**
 * Get full mission status including time estimates.
 * @param {string} missionId
 */
export async function getMissionStatus(missionId) {
  const mission = await loadMission(missionId);
  if (!mission) return null;

  const now = Date.now();
  const startedAtMs = mission.startedAt ? new Date(mission.startedAt).getTime() : null;
  const completedAtMs = mission.completedAt ? new Date(mission.completedAt).getTime() : null;
  const elapsedTime = startedAtMs ? (completedAtMs || now) - startedAtMs : 0;

  let estimatedRemaining = null;
  if (startedAtMs && mission.progress > 0 && mission.progress < 1 && !completedAtMs) {
    const totalEstimate = elapsedTime / mission.progress;
    estimatedRemaining = Math.max(0, totalEstimate - elapsedTime);
  }

  return {
    missionId: mission.missionId,
    workspaceId: mission.workspaceId,
    name: mission.name,
    goal: mission.goal,
    status: mission.status,
    progress: mission.progress,
    currentStep: mission.currentStep,
    elapsedTime,
    estimatedRemaining,
    checkpoints: mission.checkpoints || [],
    iterationsCount: mission.iterationsCount,
    toolCallsCount: mission.toolCallsCount,
    costUsd: mission.costUsd,
    milestones: mission.milestones || [],
    constraints: mission.constraints,
    createdAt: mission.createdAt,
    startedAt: mission.startedAt,
    completedAt: mission.completedAt,
    lastCheckpointAt: mission.lastCheckpointAt,
    abortReason: mission.abortReason,
    failureReason: mission.failureReason,
  };
}

/**
 * Get a mission by id (full record).
 * @param {string} missionId
 */
export async function getMission(missionId) {
  return loadMission(missionId);
}

/**
 * List missions in a workspace, optionally filtered by status.
 * @param {string} workspaceId
 * @param {string} [status]
 */
export async function listMissions(workspaceId, status) {
  const path = indexPath(workspaceId);
  const data = normalizeIndex(await readJsonPath(path, null));
  let list = data.missions.slice();
  if (status && VALID_STATUSES.has(status)) {
    list = list.filter((m) => m.status === status);
  }
  list.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return list;
}

/**
 * Get the event history for a mission.
 * @param {string} missionId
 * @param {number} [limit=100]
 */
export async function getMissionHistory(missionId, limit = 100) {
  const id = sanitizeId(missionId);
  if (!id) return [];
  const data = normalizeHistory(await readJsonPath(historyPath(id), null));
  const events = data.events.slice().reverse();
  const max = Math.min(Number(limit) || 100, MAX_HISTORY_EVENTS);
  return events.slice(0, max);
}

/**
 * Update progress (0..1 or step number) for a mission.
 * @param {string} missionId
 * @param {number|object} progress
 */
export async function updateProgress(missionId, progress) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");

  let value = mission.progress;
  let currentStep = mission.currentStep;
  if (typeof progress === "number") {
    value = Math.max(0, Math.min(1, progress));
  } else if (progress && typeof progress === "object") {
    if (typeof progress.value === "number") {
      value = Math.max(0, Math.min(1, progress.value));
    } else if (typeof progress.step === "number" && typeof progress.totalSteps === "number" && progress.totalSteps > 0) {
      value = Math.max(0, Math.min(1, progress.step / progress.totalSteps));
    }
    if (typeof progress.currentStep === "string") {
      currentStep = progress.currentStep.slice(0, 200);
    }
  }
  mission.progress = value;
  mission.currentStep = currentStep;
  await saveMission(mission);
  return { progress: value, currentStep };
}

/**
 * Record a milestone for a mission.
 * @param {string} missionId
 * @param {string|object} milestone
 */
export async function reportMilestone(missionId, milestone) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  const entry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    label: typeof milestone === "string"
      ? milestone.slice(0, 500)
      : (milestone?.label || "milestone").slice(0, 500),
    detail: typeof milestone === "object" ? milestone?.detail || "" : "",
  };
  mission.milestones = Array.isArray(mission.milestones) ? mission.milestones : [];
  mission.milestones.push(entry);
  await saveMission(mission);
  await appendHistory(missionId, { type: "milestone", message: entry.label, milestoneId: entry.id });
  return entry;
}

/**
 * Increment counters and persist (used by the runner).
 * @param {string} missionId
 * @param {{ iterations?: number, toolCalls?: number, costUsd?: number }} delta
 */
export async function incrementCounters(missionId, delta = {}) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  if (typeof delta.iterations === "number") {
    mission.iterationsCount = (mission.iterationsCount || 0) + delta.iterations;
  }
  if (typeof delta.toolCalls === "number") {
    mission.toolCallsCount = (mission.toolCallsCount || 0) + delta.toolCalls;
  }
  if (typeof delta.costUsd === "number") {
    mission.costUsd = (mission.costUsd || 0) + delta.costUsd;
  }
  await saveMission(mission);
  return {
    iterationsCount: mission.iterationsCount,
    toolCallsCount: mission.toolCallsCount,
    costUsd: mission.costUsd,
  };
}

/**
 * Append a message to the mission's conversation history.
 * @param {string} missionId
 * @param {object} message
 */
export async function appendConversationMessage(missionId, message) {
  const mission = await loadMission(missionId);
  if (!mission) throw new Error("Mission not found");
  mission.conversationHistory = Array.isArray(mission.conversationHistory)
    ? mission.conversationHistory
    : [];
  mission.conversationHistory.push({
    timestamp: new Date().toISOString(),
    ...message,
  });
  await saveMission(mission);
}

/**
 * Check whether a mission is within its constraints.
 * @param {object} mission - mission record (not just id)
 * @returns {{ withinLimits: boolean, violations: string[] }}
 */
export function checkConstraints(mission) {
  if (!mission || typeof mission !== "object") {
    return { withinLimits: false, violations: ["mission not found"] };
  }
  const violations = [];
  const constraints = mission.constraints || {};

  // Time limit
  if (mission.startedAt) {
    const elapsedHours = (Date.now() - new Date(mission.startedAt).getTime()) / (1000 * 60 * 60);
    const maxHours = mission.maxDurationHours || DEFAULT_MAX_DURATION_HOURS;
    if (elapsedHours > maxHours) {
      violations.push(`time limit exceeded: ${elapsedHours.toFixed(2)}h > ${maxHours}h`);
    }
  }

  // Tool call limit
  const maxToolCalls = constraints.maxToolCalls || DEFAULT_MAX_TOOL_CALLS;
  if ((mission.toolCallsCount || 0) > maxToolCalls) {
    violations.push(`tool call limit exceeded: ${mission.toolCallsCount} > ${maxToolCalls}`);
  }

  // Cost limit
  const maxCost = constraints.maxCostUsd || DEFAULT_MAX_COST_USD;
  if ((mission.costUsd || 0) > maxCost) {
    violations.push(`cost limit exceeded: $${(mission.costUsd || 0).toFixed(2)} > $${maxCost}`);
  }

  return { withinLimits: violations.length === 0, violations };
}

/**
 * Delete a mission and all its checkpoints.
 * @param {string} workspaceId
 * @param {string} missionId
 */
export async function deleteMission(workspaceId, missionId) {
  const id = sanitizeId(missionId);
  if (!id) return false;
  const mission = await loadMission(id);
  if (!mission) return false;
  await removeIndexEntry(workspaceId, id);
  try {
    const dir = missionDir(id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) {}
  return true;
}

// Internal: list checkpoint files on disk (used by tests / restore tools)
export function _listCheckpointFiles(missionId) {
  const id = sanitizeId(missionId);
  if (!id) return [];
  const dir = checkpointDir(id);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({
        file: f,
        mtime: statSync(join(dir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

export const _internals = {
  DEFAULT_MAX_DURATION_HOURS,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_COST_USD,
  MAX_CHECKPOINTS_PER_MISSION,
  loadMission,
  saveMission,
  appendHistory,
};
