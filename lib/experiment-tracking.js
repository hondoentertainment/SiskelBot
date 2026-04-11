// @ts-check
/**
 * Phase 64.4: Experiment tracking.
 *
 * Minimal W&B/MLflow-like bridge. Tracks experiments, runs, params, and
 * time-stamped metric series. All persisted via `json-path-store.js`.
 *
 *   - `createExperiment(name, opts)` — create an experiment
 *   - `startRun(experimentId, opts)` — create a run
 *   - `logParam(runId, key, value)` — log a hyperparameter
 *   - `logMetric(runId, key, value, step?)` — append a metric value
 *   - `listRuns(experimentId?)` — list runs, optionally by experiment
 *   - `getRun(runId)` — full run record
 *   - `compareRuns(runIds, metric)` — side-by-side metric comparison
 *
 * @module experiment-tracking
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function storePath() {
  return join(getDataDir(), "experiment-tracking.json");
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    experiments: {},
    runs: {},
  });
  if (!data.experiments || typeof data.experiments !== "object") data.experiments = {};
  if (!data.runs || typeof data.runs !== "object") data.runs = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    experiments: data.experiments || {},
    runs: data.runs || {},
  });
}

/* -------------------------------------------------------------------------- */
/* Experiments & runs                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Create an experiment (or fetch existing by name).
 *
 * @param {string} name
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function createExperiment(name, opts = {}) {
  if (!name || typeof name !== "string") throw new Error("name required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const existing = Object.values(data.experiments).find((e) => /** @type {any} */ (e).name === name);
    if (existing) return existing;
    const id = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const rec = {
      id,
      name,
      description: opts.description || "",
      tags: Array.isArray(opts.tags) ? opts.tags.slice() : [],
      createdAt: now,
      updatedAt: now,
    };
    data.experiments[id] = rec;
    await saveStore(data);
    return rec;
  });
}

/**
 * Start a new run for an experiment.
 *
 * @param {string} experimentId
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
export async function startRun(experimentId, opts = {}) {
  if (!experimentId) throw new Error("experimentId required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const exp = data.experiments[experimentId];
    if (!exp) throw new Error(`experiment "${experimentId}" not found`);
    const id = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    const run = {
      id,
      experimentId,
      name: opts.name || id,
      params: {},
      metrics: {},
      status: "running",
      startedAt: now,
      endedAt: null,
    };
    data.runs[id] = run;
    await saveStore(data);
    return run;
  });
}

/**
 * Log a parameter on a run.
 *
 * @param {string} runId
 * @param {string} key
 * @param {any} value
 * @returns {Promise<object>}
 */
export async function logParam(runId, key, value) {
  if (!runId) throw new Error("runId required");
  if (!key) throw new Error("key required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const run = data.runs[runId];
    if (!run) throw new Error(`run "${runId}" not found`);
    run.params[key] = value;
    await saveStore(data);
    return run;
  });
}

/**
 * Append a metric value on a run. Metrics are stored as a list of
 * {value, step, timestamp} entries.
 *
 * @param {string} runId
 * @param {string} key
 * @param {number} value
 * @param {number} [step]
 * @returns {Promise<object>}
 */
export async function logMetric(runId, key, value, step = null) {
  if (!runId) throw new Error("runId required");
  if (!key) throw new Error("key required");
  if (!Number.isFinite(value)) throw new Error("value must be a number");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const run = data.runs[runId];
    if (!run) throw new Error(`run "${runId}" not found`);
    if (!run.metrics[key]) run.metrics[key] = [];
    run.metrics[key].push({
      value,
      step: Number.isFinite(step) ? step : run.metrics[key].length,
      timestamp: new Date().toISOString(),
    });
    await saveStore(data);
    return run;
  });
}

/**
 * Mark a run as finished.
 *
 * @param {string} runId
 * @param {string} [status]
 * @returns {Promise<object>}
 */
export async function endRun(runId, status = "finished") {
  if (!runId) throw new Error("runId required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const run = data.runs[runId];
    if (!run) throw new Error(`run "${runId}" not found`);
    run.status = status;
    run.endedAt = new Date().toISOString();
    await saveStore(data);
    return run;
  });
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/** List runs, optionally by experiment. */
export async function listRuns(experimentId) {
  const data = await loadStore();
  const runs = Object.values(data.runs);
  if (experimentId) return runs.filter((r) => /** @type {any} */ (r).experimentId === experimentId);
  return runs;
}

/** Fetch a single run by id. */
export async function getRun(runId) {
  if (!runId) return null;
  const data = await loadStore();
  return data.runs[runId] || null;
}

/** List experiments. */
export async function listExperiments() {
  const data = await loadStore();
  return Object.values(data.experiments);
}

/**
 * Compare runs on a single metric, returning the latest value per run.
 *
 * @param {string[]} runIds
 * @param {string} metric
 * @returns {Promise<Array<{ runId: string, value: number | null, count: number }>>}
 */
export async function compareRuns(runIds, metric) {
  if (!Array.isArray(runIds)) throw new Error("runIds array required");
  if (!metric) throw new Error("metric required");
  const data = await loadStore();
  /** @type {Array<{ runId: string, value: number | null, count: number }>} */
  const out = [];
  for (const id of runIds) {
    const run = data.runs[id];
    if (!run) {
      out.push({ runId: id, value: null, count: 0 });
      continue;
    }
    const series = run.metrics[metric] || [];
    const last = series.length > 0 ? series[series.length - 1].value : null;
    out.push({ runId: id, value: last, count: series.length });
  }
  return out;
}
