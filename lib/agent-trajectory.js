/**
 * Phase 59: Agent run trajectory (ordered steps) for debugging and replay-oriented tooling.
 * Phase 71: Durable store via json-path-store (Postgres / SQLite / file); optional in-memory L1 cache.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const DEFAULT_TTL_MS = Number(process.env.AGENT_TRAJECTORY_TTL_MS) || 600_000;
const DEFAULT_MAX_ENTRIES = Math.max(10, Number(process.env.AGENT_TRAJECTORY_MAX_STORE) || 100);
const DURABLE_ENABLED = process.env.AGENT_TRAJECTORY_DURABLE !== "0";

/** @type {Map<string, { storedAt: number; payload: object }>} */
const trajectoryL1 = new Map();

function storeFilePath() {
  return join(getDataDir(), "agent-trajectories.json");
}

function pruneL1() {
  const now = Date.now();
  for (const [id, entry] of trajectoryL1.entries()) {
    if (now - entry.storedAt > DEFAULT_TTL_MS) trajectoryL1.delete(id);
  }
  if (trajectoryL1.size <= DEFAULT_MAX_ENTRIES) return;
  const sorted = [...trajectoryL1.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
  while (sorted.length > DEFAULT_MAX_ENTRIES) {
    const drop = sorted.shift();
    if (drop) trajectoryL1.delete(drop[0]);
  }
}

function normalizeRuns(data) {
  if (!data || typeof data !== "object") return {};
  const r = data.runs;
  if (r && typeof r === "object" && !Array.isArray(r)) return { ...r };
  return {};
}

function normalizeWorkspaceIndex(data) {
  if (!data || typeof data !== "object") return {};
  const wi = data.workspaceIndex;
  if (wi && typeof wi === "object" && !Array.isArray(wi)) {
    const out = {};
    for (const [k, v] of Object.entries(wi)) {
      if (Array.isArray(v)) out[k] = v.filter((e) => e && typeof e.runId === "string");
    }
    return out;
  }
  return {};
}

function stepCountFromPayload(payload) {
  if (!payload || typeof payload !== "object") return 0;
  if (typeof payload.stepCount === "number") return payload.stepCount;
  if (Array.isArray(payload.steps)) return payload.steps.length;
  return 0;
}

const INDEX_MAX_PER_WORKSPACE = Math.min(500, Math.max(50, Number(process.env.AGENT_TRAJECTORY_INDEX_MAX) || 300));

/**
 * @param {string} runId
 * @param {object} snapshot
 */
export async function saveTrajectory(runId, snapshot) {
  if (!runId || typeof snapshot !== "object") return;
  pruneL1();
  const storedAt = Date.now();
  trajectoryL1.set(runId, { storedAt, payload: snapshot });

  if (!DURABLE_ENABLED) {
    pruneL1();
    return;
  }

  const path = storeFilePath();
  await withPathLock(path, async () => {
    const raw = await readJsonPath(path, { _version: 1, runs: {}, workspaceIndex: {} });
    let runs = normalizeRuns(raw);
    let workspaceIndex = normalizeWorkspaceIndex(raw);
    const ws =
      (snapshot && typeof snapshot.workspace === "string" && snapshot.workspace.trim()) || "default";

    runs[runId] = { storedAt: new Date(storedAt).toISOString(), payload: snapshot };

    const entries = Object.entries(runs).sort(
      (a, b) => new Date(a[1].storedAt).getTime() - new Date(b[1].storedAt).getTime(),
    );
    const removed = new Set();
    while (entries.length > DEFAULT_MAX_ENTRIES) {
      const drop = entries.shift();
      if (drop) {
        removed.add(drop[0]);
        delete runs[drop[0]];
      }
    }

    let order = Array.isArray(workspaceIndex[ws]) ? [...workspaceIndex[ws]] : [];
    order.unshift({
      runId,
      storedAt: runs[runId].storedAt,
      stepCount: stepCountFromPayload(snapshot),
    });
    const seen = new Set();
    order = order.filter((e) => {
      if (!e || !e.runId || seen.has(e.runId)) return false;
      seen.add(e.runId);
      return !!runs[e.runId];
    });
    workspaceIndex[ws] = order.slice(0, INDEX_MAX_PER_WORKSPACE);

    if (removed.size) {
      for (const k of Object.keys(workspaceIndex)) {
        workspaceIndex[k] = (workspaceIndex[k] || []).filter((e) => !removed.has(e.runId) && runs[e.runId]);
      }
    }

    await writeJsonPath(path, { _version: 1, runs, workspaceIndex });
  });
}

/**
 * @param {string} runId
 * @returns {Promise<object|null>}
 */
export async function loadTrajectory(runId) {
  if (!runId) return null;
  pruneL1();

  const mem = trajectoryL1.get(runId);
  if (mem) {
    if (Date.now() - mem.storedAt > DEFAULT_TTL_MS) {
      trajectoryL1.delete(runId);
    } else {
      return mem.payload;
    }
  }

  if (!DURABLE_ENABLED) return null;

  const path = storeFilePath();
  const raw = await readJsonPath(path, { _version: 1, runs: {} });
  const runs = normalizeRuns(raw);
  const row = runs[runId];
  if (!row || !row.payload) return null;
  const ts = new Date(row.storedAt).getTime();
  if (Number.isFinite(ts) && Date.now() - ts > DEFAULT_TTL_MS) {
    await withPathLock(path, async () => {
      const raw2 = await readJsonPath(path, { _version: 1, runs: {}, workspaceIndex: {} });
      const r2 = normalizeRuns(raw2);
      delete r2[runId];
      let workspaceIndex = normalizeWorkspaceIndex(raw2);
      for (const k of Object.keys(workspaceIndex)) {
        workspaceIndex[k] = (workspaceIndex[k] || []).filter((e) => e && e.runId !== runId);
      }
      await writeJsonPath(path, { _version: 1, runs: r2, workspaceIndex });
    });
    return null;
  }
  trajectoryL1.set(runId, { storedAt: ts || Date.now(), payload: row.payload });
  return row.payload;
}

/**
 * @param {object} meta - { runId, workspace?, userId? }
 */
export function createTrajectoryCollector(meta) {
  const steps = [];
  return {
    record(step) {
      steps.push({ ...step, at: new Date().toISOString() });
    },
    truncate(text, max = 400) {
      const s = typeof text === "string" ? text : JSON.stringify(text ?? "");
      return s.length <= max ? s : `${s.slice(0, max)}…`;
    },
    getSnapshot() {
      return {
        ...meta,
        recordedAt: new Date().toISOString(),
        stepCount: steps.length,
        steps,
      };
    },
  };
}

export function trajectoryApiEnabled() {
  return process.env.AGENT_TRAJECTORY_API !== "0";
}

function storedAtToMs(storedAt) {
  if (typeof storedAt === "number" && Number.isFinite(storedAt)) return storedAt;
  const t = new Date(storedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * List recent trajectories for a workspace (memory + durable), newest first.
 * @param {{ workspace?: string, limit?: number, offset?: number }} opts
 * @returns {Promise<{ items: object[], total: number, limit: number, offset: number }>}
 */
export async function listTrajectories(opts = {}) {
  const workspace = String(opts.workspace || "default").trim();
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 30));
  const offset = Math.max(0, Number(opts.offset) || 0);
  pruneL1();

  /** @type {Map<string, { runId: string, storedAtMs: number, workspace: string, stepCount: number }>} */
  const merged = new Map();

  function ingest(runId, storedAtMs, payload) {
    if (!runId || !payload || typeof payload !== "object") return;
    if (payload.workspace !== workspace) return;
    const prev = merged.get(runId);
    if (!prev || storedAtMs >= prev.storedAtMs) {
      merged.set(runId, {
        runId,
        storedAtMs,
        workspace: payload.workspace || workspace,
        stepCount: typeof payload.stepCount === "number" ? payload.stepCount : 0,
      });
    }
  }

  for (const [runId, { storedAt, payload }] of trajectoryL1.entries()) {
    ingest(runId, storedAt, payload);
  }

  if (DURABLE_ENABLED) {
    const path = storeFilePath();
    const raw = await readJsonPath(path, { _version: 1, runs: {}, workspaceIndex: {} });
    const runs = normalizeRuns(raw);
    const workspaceIndex = normalizeWorkspaceIndex(raw);
    const indexed = workspaceIndex[workspace];
    if (Array.isArray(indexed) && indexed.length > 0) {
      for (const e of indexed) {
        if (!e || !e.runId) continue;
        const row = runs[e.runId];
        if (!row || !row.payload) continue;
        const ms = storedAtToMs(row.storedAt);
        ingest(e.runId, ms, row.payload);
      }
    } else {
      for (const [runId, row] of Object.entries(runs)) {
        if (!row || !row.payload) continue;
        const ms = storedAtToMs(row.storedAt);
        ingest(runId, ms, row.payload);
      }
    }
  }

  const arr = [...merged.values()].sort((a, b) => b.storedAtMs - a.storedAtMs);
  const total = arr.length;
  const slice = arr.slice(offset, offset + limit).map((row) => ({
    runId: row.runId,
    workspace: row.workspace,
    stepCount: row.stepCount,
    storedAt: new Date(row.storedAtMs).toISOString(),
  }));

  return { items: slice, total, limit, offset };
}
