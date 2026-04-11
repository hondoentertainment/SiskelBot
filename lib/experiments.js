/**
 * ML experiment tracking (Phase 38.4).
 * Track runs, parameters, metrics, artifacts, and compare experiments.
 * Storage: data/experiments/{workspaceId}/{experimentId}.json via json-path-store.
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_METRIC_POINTS = 100_000;
const MAX_RUNS_PER_EXPERIMENT = 10_000;

// Runtime index mapping runId -> { workspaceId, experimentId } for fast lookup.
// Rehydrated lazily on first access.
const runIndex = new Map();

function safeId(id, fallback = "default") {
  if (typeof id !== "string") return fallback;
  const trimmed = id.trim();
  if (!trimmed) return fallback;
  // Strip separators that would break path routing
  return trimmed.replace(/[/\\]/g, "_");
}

function experimentPath(workspaceId, experimentId) {
  const ws = safeId(workspaceId);
  const exp = safeId(experimentId);
  return join(getDataDir(), "experiments", ws, `${exp}.json`);
}

function experimentIndexPath(workspaceId) {
  const ws = safeId(workspaceId);
  return join(getDataDir(), "experiments", ws, "_index.json");
}

async function loadExperimentFile(workspaceId, experimentId) {
  const path = experimentPath(workspaceId, experimentId);
  const data = await readJsonPath(path, null);
  if (!data || typeof data !== "object" || !data.id) return null;
  return data;
}

async function saveExperimentFile(experiment) {
  const path = experimentPath(experiment.workspaceId, experiment.id);
  await writeJsonPath(path, experiment);
}

async function loadWorkspaceIndex(workspaceId) {
  const path = experimentIndexPath(workspaceId);
  const data = await readJsonPath(path, { _version: 1, experiments: [] });
  return Array.isArray(data.experiments) ? data.experiments : [];
}

async function saveWorkspaceIndex(workspaceId, experiments) {
  const path = experimentIndexPath(workspaceId);
  await writeJsonPath(path, { _version: 1, experiments });
}

async function findExperimentIndex(workspaceId, experimentId) {
  const entries = await loadWorkspaceIndex(workspaceId);
  return entries.find((e) => e.id === experimentId) || null;
}

/**
 * Resolve the workspace + experiment for a runId by scanning workspace indices.
 * Populates the runtime index on success.
 */
async function resolveRunLocation(runId) {
  if (runIndex.has(runId)) return runIndex.get(runId);
  const indexDir = join(getDataDir(), "experiments");
  // We do not have a cross-workspace index on disk. Callers that know the workspace
  // should use the lower-level helpers. For tests and single-workspace use, try the
  // experiment record stored with the runIndex cache.
  // Without filesystem directory scanning here (storage may be KV), we return null.
  void indexDir;
  return null;
}

function rememberRun(runId, workspaceId, experimentId) {
  runIndex.set(runId, { workspaceId, experimentId });
}

function forgetExperimentRuns(experiment) {
  if (!experiment || !Array.isArray(experiment.runs)) return;
  for (const run of experiment.runs) {
    runIndex.delete(run.id);
  }
}

async function mutateExperiment(workspaceId, experimentId, fn) {
  const path = experimentPath(workspaceId, experimentId);
  return withPathLock(path, async () => {
    const exp = await loadExperimentFile(workspaceId, experimentId);
    if (!exp) throw new Error(`experiment not found: ${experimentId}`);
    const result = await fn(exp);
    await saveExperimentFile(exp);
    return result;
  });
}

async function mutateRun(runId, workspaceId, experimentId, fn) {
  return mutateExperiment(workspaceId, experimentId, async (exp) => {
    const run = exp.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    return fn(run, exp);
  });
}

/**
 * Internal helper: find the workspace/experiment that owns a runId.
 * Uses the runtime index; throws if unknown.
 */
function locateRunSync(runId) {
  const loc = runIndex.get(runId);
  if (!loc) {
    throw new Error(`run not found: ${runId}`);
  }
  return loc;
}

// ─── Experiments ────────────────────────────────────────────────────────────

/**
 * Create a new experiment.
 * @param {string} name
 * @param {string} workspaceId
 * @param {object} [metadata]
 * @returns {Promise<{ id: string, name: string, workspaceId: string, createdAt: string, runs: Array }>}
 */
export async function createExperiment(name, workspaceId, metadata = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  const ws = safeId(workspaceId);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const experiment = {
    id,
    name: name.trim().slice(0, 200),
    workspaceId: ws,
    description: typeof metadata.description === "string" ? metadata.description.slice(0, 2000) : null,
    tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 32).map(String) : [],
    metadata: metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata : {},
    createdAt,
    updatedAt: createdAt,
    runs: [],
  };

  await saveExperimentFile(experiment);
  await withPathLock(experimentIndexPath(ws), async () => {
    const entries = await loadWorkspaceIndex(ws);
    entries.push({ id, name: experiment.name, createdAt });
    await saveWorkspaceIndex(ws, entries);
  });

  return experiment;
}

/**
 * Get an experiment by id. Requires the workspace to be known via the runtime
 * or explicit call; scans all workspaces if not provided.
 * @param {string} experimentId
 * @param {string} [workspaceId]
 */
export async function getExperiment(experimentId, workspaceId) {
  if (workspaceId) {
    return loadExperimentFile(workspaceId, experimentId);
  }
  // Fallback: look up via runIndex if any run belongs to this experiment.
  for (const [, loc] of runIndex) {
    if (loc.experimentId === experimentId) {
      return loadExperimentFile(loc.workspaceId, experimentId);
    }
  }
  return null;
}

/**
 * List experiments in a workspace.
 */
export async function listExperiments(workspaceId) {
  const ws = safeId(workspaceId);
  const entries = await loadWorkspaceIndex(ws);
  const results = [];
  for (const entry of entries) {
    const exp = await loadExperimentFile(ws, entry.id);
    if (!exp) continue;
    results.push({
      id: exp.id,
      name: exp.name,
      workspaceId: exp.workspaceId,
      description: exp.description,
      tags: exp.tags,
      createdAt: exp.createdAt,
      updatedAt: exp.updatedAt,
      runCount: Array.isArray(exp.runs) ? exp.runs.length : 0,
    });
  }
  return results;
}

/**
 * Delete an experiment and all its runs.
 */
export async function deleteExperiment(experimentId, workspaceId) {
  const ws = safeId(workspaceId);
  const existing = await loadExperimentFile(ws, experimentId);
  if (!existing) return false;

  forgetExperimentRuns(existing);

  // Overwrite with a tombstone so KV backends treat it as empty.
  await writeJsonPath(experimentPath(ws, experimentId), { _deleted: true });

  await withPathLock(experimentIndexPath(ws), async () => {
    const entries = await loadWorkspaceIndex(ws);
    const filtered = entries.filter((e) => e.id !== experimentId);
    await saveWorkspaceIndex(ws, filtered);
  });

  return true;
}

// ─── Runs ───────────────────────────────────────────────────────────────────

/**
 * Start a new run inside an experiment.
 * @param {string} experimentId
 * @param {object} [metadata] - { name?, tags?, baselineRunId?, workspaceId? }
 */
export async function startRun(experimentId, metadata = {}) {
  const workspaceId = metadata.workspaceId;
  if (!workspaceId) {
    // Allow callers that stored experiment metadata in the runIndex to omit workspaceId.
    const any = [...runIndex.values()].find((v) => v.experimentId === experimentId);
    if (!any) {
      throw new Error("workspaceId is required to start a run");
    }
    metadata.workspaceId = any.workspaceId;
  }
  const ws = safeId(metadata.workspaceId);
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  await mutateExperiment(ws, experimentId, async (exp) => {
    if (exp.runs.length >= MAX_RUNS_PER_EXPERIMENT) {
      // Drop the oldest completed run to bound file size.
      const dropIdx = exp.runs.findIndex((r) => r.status !== "running");
      if (dropIdx >= 0) {
        const dropped = exp.runs.splice(dropIdx, 1)[0];
        runIndex.delete(dropped.id);
      }
    }
    const run = {
      id: runId,
      experimentId,
      name: typeof metadata.name === "string" ? metadata.name.slice(0, 200) : null,
      tags: Array.isArray(metadata.tags) ? metadata.tags.slice(0, 32).map(String) : [],
      baselineRunId: typeof metadata.baselineRunId === "string" ? metadata.baselineRunId : null,
      status: "running",
      params: {},
      metrics: {}, // { key: [{ step, value, timestamp }] }
      artifacts: [],
      startedAt,
      endedAt: null,
      duration: null,
    };
    exp.runs.push(run);
    exp.updatedAt = startedAt;
  });

  rememberRun(runId, ws, experimentId);
  return { runId, startedAt, status: "running" };
}

/**
 * Log a single hyperparameter (immutable once set).
 */
export async function logParam(runId, key, value) {
  if (!key || typeof key !== "string") {
    throw new Error("param key is required");
  }
  const loc = locateRunSync(runId);
  return mutateRun(runId, loc.workspaceId, loc.experimentId, (run) => {
    if (key in run.params) {
      throw new Error(`param ${key} is immutable and already set`);
    }
    run.params[key] = value;
  });
}

/**
 * Log multiple hyperparameters at once.
 */
export async function logParams(runId, params) {
  if (!params || typeof params !== "object") {
    throw new Error("params must be an object");
  }
  const loc = locateRunSync(runId);
  return mutateRun(runId, loc.workspaceId, loc.experimentId, (run) => {
    for (const [key, value] of Object.entries(params)) {
      if (key in run.params) {
        throw new Error(`param ${key} is immutable and already set`);
      }
      run.params[key] = value;
    }
  });
}

/**
 * Log a metric point. Multiple points are kept as a time series.
 */
export async function logMetric(runId, key, value, step) {
  if (!key || typeof key !== "string") {
    throw new Error("metric key is required");
  }
  const numValue = Number(value);
  if (!Number.isFinite(numValue)) {
    throw new Error("metric value must be a finite number");
  }
  const loc = locateRunSync(runId);
  return mutateRun(runId, loc.workspaceId, loc.experimentId, (run) => {
    if (!Array.isArray(run.metrics[key])) run.metrics[key] = [];
    const series = run.metrics[key];
    const nextStep = Number.isFinite(Number(step)) ? Number(step) : series.length;
    series.push({
      step: nextStep,
      value: numValue,
      timestamp: new Date().toISOString(),
    });
    if (series.length > MAX_METRIC_POINTS) {
      series.splice(0, series.length - MAX_METRIC_POINTS);
    }
  });
}

/**
 * Log multiple metrics at once. All share the same step if provided.
 */
export async function logMetrics(runId, metrics, step) {
  if (!metrics || typeof metrics !== "object") {
    throw new Error("metrics must be an object");
  }
  const loc = locateRunSync(runId);
  return mutateRun(runId, loc.workspaceId, loc.experimentId, (run) => {
    for (const [key, value] of Object.entries(metrics)) {
      const numValue = Number(value);
      if (!Number.isFinite(numValue)) continue;
      if (!Array.isArray(run.metrics[key])) run.metrics[key] = [];
      const series = run.metrics[key];
      const nextStep = Number.isFinite(Number(step)) ? Number(step) : series.length;
      series.push({
        step: nextStep,
        value: numValue,
        timestamp: new Date().toISOString(),
      });
      if (series.length > MAX_METRIC_POINTS) {
        series.splice(0, series.length - MAX_METRIC_POINTS);
      }
    }
  });
}

/**
 * Register an artifact produced by a run.
 */
export async function logArtifact(runId, name, path, metadata = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("artifact name is required");
  }
  const loc = locateRunSync(runId);
  return mutateRun(runId, loc.workspaceId, loc.experimentId, (run) => {
    run.artifacts.push({
      id: randomUUID(),
      name,
      path: typeof path === "string" ? path : null,
      metadata: metadata && typeof metadata === "object" ? metadata : {},
      loggedAt: new Date().toISOString(),
    });
  });
}

/**
 * Update a run's status.
 * @param {string} runId
 * @param {"running"|"completed"|"failed"|"aborted"} status
 */
export async function setRunStatus(runId, status) {
  const valid = ["running", "completed", "failed", "aborted"];
  if (!valid.includes(status)) {
    throw new Error(`status must be one of ${valid.join(", ")}`);
  }
  const loc = locateRunSync(runId);
  return mutateRun(runId, loc.workspaceId, loc.experimentId, (run, exp) => {
    run.status = status;
    if (status !== "running") {
      const endedAt = new Date().toISOString();
      run.endedAt = endedAt;
      const start = new Date(run.startedAt).getTime();
      const end = new Date(endedAt).getTime();
      run.duration = Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
    }
    exp.updatedAt = new Date().toISOString();
  });
}

/**
 * Get a run by id, including params, metrics, artifacts.
 */
export async function getRun(runId) {
  let loc;
  try {
    loc = locateRunSync(runId);
  } catch {
    const resolved = await resolveRunLocation(runId);
    if (!resolved) return null;
    loc = resolved;
  }
  const exp = await loadExperimentFile(loc.workspaceId, loc.experimentId);
  if (!exp) return null;
  const run = exp.runs.find((r) => r.id === runId);
  if (!run) return null;
  return { ...run };
}

/**
 * List runs in an experiment with optional filtering and sorting.
 * @param {string} experimentId
 * @param {object} [options] - { status, limit, sortBy, sortOrder, workspaceId }
 */
export async function listRuns(experimentId, options = {}) {
  const workspaceId = options.workspaceId
    || [...runIndex.values()].find((v) => v.experimentId === experimentId)?.workspaceId;
  if (!workspaceId) return [];
  const exp = await loadExperimentFile(workspaceId, experimentId);
  if (!exp) return [];
  let runs = [...exp.runs];

  if (options.status) {
    runs = runs.filter((r) => r.status === options.status);
  }

  const sortBy = options.sortBy || "startedAt";
  const sortOrder = options.sortOrder === "asc" ? 1 : -1;
  runs.sort((a, b) => {
    const av = getSortValue(a, sortBy);
    const bv = getSortValue(b, sortBy);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * sortOrder;
    if (av > bv) return 1 * sortOrder;
    return 0;
  });

  if (Number.isFinite(options.limit) && options.limit > 0) {
    runs = runs.slice(0, options.limit);
  }
  return runs;
}

function getSortValue(run, sortBy) {
  if (sortBy === "startedAt") return run.startedAt;
  if (sortBy === "endedAt") return run.endedAt;
  if (sortBy === "duration") return run.duration;
  if (sortBy === "status") return run.status;
  if (sortBy?.startsWith("metric.")) {
    const key = sortBy.slice("metric.".length);
    const series = run.metrics[key];
    if (!Array.isArray(series) || series.length === 0) return null;
    return series[series.length - 1].value;
  }
  if (sortBy?.startsWith("param.")) {
    const key = sortBy.slice("param.".length);
    return run.params[key] ?? null;
  }
  return run[sortBy] ?? null;
}

// ─── Analysis ───────────────────────────────────────────────────────────────

/**
 * Side-by-side comparison of params and metrics across runs.
 * @param {string[]} runIds
 */
export async function compareRuns(runIds) {
  if (!Array.isArray(runIds) || runIds.length === 0) {
    return { params: {}, metrics: {}, runs: [] };
  }
  const runs = [];
  for (const id of runIds) {
    const run = await getRun(id);
    if (run) runs.push(run);
  }

  const params = {};
  const metrics = {};
  for (const run of runs) {
    for (const [key, value] of Object.entries(run.params || {})) {
      if (!params[key]) params[key] = {};
      params[key][run.id] = value;
    }
    for (const [key, series] of Object.entries(run.metrics || {})) {
      if (!Array.isArray(series) || series.length === 0) continue;
      if (!metrics[key]) metrics[key] = {};
      metrics[key][run.id] = series[series.length - 1].value;
    }
  }

  return {
    runs: runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      duration: r.duration,
    })),
    params,
    metrics,
  };
}

/**
 * Get the time series for a single metric on a run.
 */
export async function getMetricHistory(runId, metric) {
  const run = await getRun(runId);
  if (!run) return [];
  const series = run.metrics?.[metric];
  if (!Array.isArray(series)) return [];
  return series.map((p) => ({ step: p.step, value: p.value, timestamp: p.timestamp }));
}

/**
 * Find the run in an experiment with the best value for a given metric.
 * @param {string} experimentId
 * @param {string} metric
 * @param {"min"|"max"} direction
 */
export async function getBestRun(experimentId, metric, direction = "max", options = {}) {
  const runs = await listRuns(experimentId, { workspaceId: options.workspaceId, limit: 0 });
  let best = null;
  let bestValue = direction === "min" ? Infinity : -Infinity;
  for (const run of runs) {
    const series = run.metrics?.[metric];
    if (!Array.isArray(series) || series.length === 0) continue;
    const value = series[series.length - 1].value;
    if (direction === "min" ? value < bestValue : value > bestValue) {
      bestValue = value;
      best = { ...run, bestValue };
    }
  }
  return best;
}

/**
 * Add a tag to a run.
 */
export async function tagRun(runId, tag) {
  if (!tag || typeof tag !== "string") {
    throw new Error("tag must be a string");
  }
  const loc = locateRunSync(runId);
  return mutateRun(runId, loc.workspaceId, loc.experimentId, (run) => {
    if (!Array.isArray(run.tags)) run.tags = [];
    if (!run.tags.includes(tag)) run.tags.push(tag);
  });
}

/**
 * Search runs across a workspace. Query can filter by name, tag, status, or metric range.
 * @param {object} query - { workspaceId, experimentId?, name?, tag?, status?, metric?, min?, max? }
 */
export async function searchRuns(query = {}) {
  const ws = safeId(query.workspaceId);
  const entries = await loadWorkspaceIndex(ws);
  const results = [];
  for (const entry of entries) {
    if (query.experimentId && entry.id !== query.experimentId) continue;
    const exp = await loadExperimentFile(ws, entry.id);
    if (!exp) continue;
    for (const run of exp.runs) {
      if (query.status && run.status !== query.status) continue;
      if (query.name && !(run.name || "").toLowerCase().includes(query.name.toLowerCase())) continue;
      if (query.tag && !(Array.isArray(run.tags) && run.tags.includes(query.tag))) continue;
      if (query.metric) {
        const series = run.metrics?.[query.metric];
        if (!Array.isArray(series) || series.length === 0) continue;
        const value = series[series.length - 1].value;
        if (Number.isFinite(query.min) && value < query.min) continue;
        if (Number.isFinite(query.max) && value > query.max) continue;
      }
      // Cache the location so subsequent calls can mutate without an explicit workspace.
      rememberRun(run.id, ws, exp.id);
      results.push({
        ...run,
        experimentId: exp.id,
        experimentName: exp.name,
      });
    }
  }
  return results;
}

// ─── Test / internal helpers ────────────────────────────────────────────────

/**
 * Clear the runtime run index (used by tests to reset state).
 */
export function _resetRuntime() {
  runIndex.clear();
}
