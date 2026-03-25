/**
 * Staging trace recorder: capture agent/swarm trajectories and persist them
 * to data/traces/ for later replay through the eval harness.
 */
import { randomUUID } from "crypto";
import { readdir } from "fs/promises";
import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

function tracesDir() {
  return join(getDataDir(), "traces");
}

function traceFilePath(traceId) {
  return join(tracesDir(), `${traceId}.json`);
}

/**
 * Whether auto-recording is enabled (RECORD_TRACES=1).
 * @returns {boolean}
 */
export function autoRecordEnabled() {
  return process.env.RECORD_TRACES === "1";
}

/**
 * Record a trace (agent or swarm trajectory) to data/traces/.
 * @param {object} traceData - Trajectory snapshot (from agent-loop or swarm), plus optional metadata.
 *   Expected shape: { runId?, workspace?, userId?, steps?, toolCalls?, swarmSteps?, type?, ... }
 * @returns {Promise<{ traceId: string, path: string }>}
 */
export async function recordTrace(traceData) {
  if (!traceData || typeof traceData !== "object") {
    throw new Error("traceData must be a non-null object");
  }
  const traceId = traceData.traceId || traceData.runId || randomUUID();
  const now = new Date();
  const record = {
    traceId,
    recordedAt: now.toISOString(),
    type: traceData.type || (traceData.swarmSteps?.length ? "swarm" : "agent"),
    workspace: traceData.workspace || "default",
    userId: traceData.userId || null,
    runId: traceData.runId || traceId,
    steps: Array.isArray(traceData.steps) ? traceData.steps : [],
    stepCount: traceData.stepCount || (Array.isArray(traceData.steps) ? traceData.steps.length : 0),
    toolCalls: Array.isArray(traceData.toolCalls) ? traceData.toolCalls : [],
    swarmSteps: Array.isArray(traceData.swarmSteps) ? traceData.swarmSteps : [],
    stopReason: traceData.stopReason || null,
    content: typeof traceData.content === "string" ? traceData.content : null,
    metadata: traceData.metadata || {},
  };
  const filePath = traceFilePath(traceId);
  await writeJsonPath(filePath, record);
  return { traceId, path: filePath };
}

/**
 * List recorded traces with optional filtering.
 * @param {{ type?: "agent"|"swarm", since?: string, until?: string, workspace?: string, limit?: number, offset?: number }} options
 * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
 */
export async function listTraces(options = {}) {
  const dir = tracesDir();
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    return { items: [], total: 0, limit, offset };
  }

  const items = [];
  for (const f of files) {
    try {
      const data = await readJsonPath(join(dir, f), null);
      if (!data || typeof data !== "object") continue;
      if (options.type && data.type !== options.type) continue;
      if (options.workspace && data.workspace !== options.workspace) continue;
      if (options.since) {
        const sinceMs = new Date(options.since).getTime();
        const recMs = new Date(data.recordedAt).getTime();
        if (Number.isFinite(sinceMs) && Number.isFinite(recMs) && recMs < sinceMs) continue;
      }
      if (options.until) {
        const untilMs = new Date(options.until).getTime();
        const recMs = new Date(data.recordedAt).getTime();
        if (Number.isFinite(untilMs) && Number.isFinite(recMs) && recMs > untilMs) continue;
      }
      items.push({
        traceId: data.traceId,
        type: data.type,
        workspace: data.workspace,
        recordedAt: data.recordedAt,
        stepCount: data.stepCount || 0,
        stopReason: data.stopReason,
      });
    } catch {
      // skip corrupt files
    }
  }

  const total = items.length;
  const slice = items.slice(offset, offset + limit);
  return { items: slice, total, limit, offset };
}

/**
 * Retrieve a specific trace by ID.
 * @param {string} traceId
 * @returns {Promise<object|null>}
 */
export async function getTrace(traceId) {
  if (!traceId || typeof traceId !== "string") return null;
  try {
    const data = await readJsonPath(traceFilePath(traceId), null);
    return data && typeof data === "object" && data.traceId ? data : null;
  } catch {
    return null;
  }
}

/**
 * Delete a trace by ID.
 * @param {string} traceId
 * @returns {Promise<boolean>}
 */
export async function deleteTrace(traceId) {
  if (!traceId) return false;
  const { unlink } = await import("fs/promises");
  try {
    await unlink(traceFilePath(traceId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a recorded trace into an eval case format compatible with the eval harness.
 * Produces a `staging_trace`-target eval case that references the trace file on disk,
 * plus inline goldenTrace / agentActivity for offline evaluation.
 * @param {object} trace - Full trace record from getTrace()
 * @returns {object} eval case
 */
export function traceToEvalCase(trace) {
  if (!trace || typeof trace !== "object") {
    throw new Error("trace must be a non-null object");
  }
  const traceId = trace.traceId || "unknown";

  // Build goldenTrace from steps (tool_call events) or toolCalls
  let goldenTrace = [];
  if (Array.isArray(trace.steps)) {
    for (const step of trace.steps) {
      if (!step || step.type !== "tool_call" || !step.name) continue;
      let args = {};
      if (typeof step.argsPreview === "string") {
        try { args = JSON.parse(step.argsPreview); } catch { args = {}; }
      }
      goldenTrace.push({ name: step.name, arguments: args });
    }
  }
  if (goldenTrace.length === 0 && Array.isArray(trace.toolCalls)) {
    goldenTrace = trace.toolCalls
      .filter((tc) => tc && (tc.name || tc.function?.name))
      .map((tc) => ({
        name: tc.name || tc.function?.name || "",
        arguments: tc.args || tc.arguments || {},
      }));
  }

  const toolNames = goldenTrace.map((t) => t.name).filter(Boolean);

  // Build agentActivity
  const agentActivity = {
    type: "agent_activity",
    toolCalls: goldenTrace.map((t) => ({ name: t.name, args: t.arguments })),
    swarmSteps: Array.isArray(trace.swarmSteps) ? trace.swarmSteps : [],
  };

  const evalCase = {
    id: `staging-trace-${traceId}`,
    target: "staging_trace",
    stagingTraceFile: `data/traces/${traceId}.json`,
    generatedFrom: traceId,
    generatedAt: new Date().toISOString(),
  };

  // Add golden checks if we have tool calls
  if (toolNames.length > 0) {
    evalCase.expectedToolSequence = toolNames;
    evalCase.expectedMinAgentActivityToolCalls = toolNames.length;
  }

  return evalCase;
}
