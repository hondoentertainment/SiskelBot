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
    const raw = await readJsonPath(path, { _version: 1, runs: {} });
    let runs = normalizeRuns(raw);
    runs[runId] = { storedAt: new Date(storedAt).toISOString(), payload: snapshot };
    const entries = Object.entries(runs).sort((a, b) => new Date(a[1].storedAt).getTime() - new Date(b[1].storedAt).getTime());
    while (entries.length > DEFAULT_MAX_ENTRIES) {
      const drop = entries.shift();
      if (drop) delete runs[drop[0]];
    }
    await writeJsonPath(path, { _version: 1, runs });
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
      const r2 = normalizeRuns(await readJsonPath(path, { _version: 1, runs: {} }));
      delete r2[runId];
      await writeJsonPath(path, { _version: 1, runs: r2 });
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
