/**
 * Phase 64.4: Experiment bridge.
 *
 * W&B / MLflow-style experiment tracking using local storage only. Records
 * experiments, metric time-series, parameter dictionaries, and artifact
 * references. Comparison across experiments returns a table keyed by metric
 * name with the latest value per experiment.
 *
 * Storage layout:
 *   data/experiment-bridge/{workspaceId}.json
 *     { experiments: { [id]: {...} } }
 *   data/experiment-bridge/_index.json — id -> workspaceId map + known workspaces
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_METRIC_POINTS = 10000;
const MAX_ARTIFACTS = 500;

function sanitizeId(val, fallback = "default") {
  if (typeof val !== "string" || !val.trim()) return fallback;
  return val.trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || fallback;
}

function workspacePath(workspaceId) {
  return join(getDataDir(), "experiment-bridge", `${sanitizeId(workspaceId)}.json`);
}

function indexPath() {
  return join(getDataDir(), "experiment-bridge", "_index.json");
}

async function touchIndex(workspaceId, experimentId) {
  const ws = sanitizeId(workspaceId);
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
    const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
    if (!list.includes(ws)) list.push(ws);
    const ids = idx.ids && typeof idx.ids === "object" ? idx.ids : {};
    if (experimentId) ids[experimentId] = ws;
    await writeJsonPath(indexPath(), { workspaces: list, ids });
  });
}

async function readStore(workspaceId) {
  const store = await readJsonPath(workspacePath(workspaceId), { experiments: {} });
  return { experiments: store.experiments && typeof store.experiments === "object" ? store.experiments : {} };
}

async function resolveWorkspace(experimentId) {
  const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
  const ids = idx.ids && typeof idx.ids === "object" ? idx.ids : {};
  return ids[experimentId] || null;
}

/**
 * Create a new experiment.
 *
 * @param {{ workspaceId?: string, name: string, config?: object, tags?: string[] }} input
 */
export async function createExperiment({ workspaceId, name, config, tags } = {}) {
  if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
  const ws = sanitizeId(workspaceId);
  const id = randomUUID();
  const record = {
    id,
    workspaceId: ws,
    name: name.trim(),
    config: config && typeof config === "object" ? config : {},
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 32) : [],
    params: {},
    metrics: {},
    artifacts: [],
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const file = workspacePath(ws);
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    store.experiments[id] = record;
    await writeJsonPath(file, store);
  });
  await touchIndex(ws, id);
  return record;
}

/**
 * Log a metric point. Metrics are stored as time-series keyed by metric name.
 *
 * @param {{ experimentId: string, metric: string, value: number, step?: number }} input
 */
export async function logMetric({ experimentId, metric, value, step } = {}) {
  if (!experimentId) throw new Error("experimentId is required");
  if (typeof metric !== "string" || !metric.trim()) throw new Error("metric is required");
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("value must be a finite number");
  const ws = await resolveWorkspace(experimentId);
  if (!ws) throw new Error(`experiment ${experimentId} not found`);
  const file = workspacePath(ws);
  let record;
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    const exp = store.experiments[experimentId];
    if (!exp) throw new Error(`experiment ${experimentId} not found`);
    const metrics = exp.metrics && typeof exp.metrics === "object" ? exp.metrics : {};
    const series = Array.isArray(metrics[metric]) ? metrics[metric] : [];
    const autoStep = series.length ? (series[series.length - 1].step || 0) + 1 : 0;
    const point = {
      step: typeof step === "number" ? step : autoStep,
      value,
      timestamp: Date.now(),
    };
    series.push(point);
    if (series.length > MAX_METRIC_POINTS) series.splice(0, series.length - MAX_METRIC_POINTS);
    metrics[metric] = series;
    exp.metrics = metrics;
    exp.updatedAt = Date.now();
    record = point;
    await writeJsonPath(file, store);
  });
  return { experimentId, metric, point: record };
}

/**
 * Log (merge) a dictionary of parameters.
 */
export async function logParams({ experimentId, params } = {}) {
  if (!experimentId) throw new Error("experimentId is required");
  if (!params || typeof params !== "object") throw new Error("params must be an object");
  const ws = await resolveWorkspace(experimentId);
  if (!ws) throw new Error(`experiment ${experimentId} not found`);
  const file = workspacePath(ws);
  let merged;
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    const exp = store.experiments[experimentId];
    if (!exp) throw new Error(`experiment ${experimentId} not found`);
    exp.params = { ...(exp.params || {}), ...params };
    exp.updatedAt = Date.now();
    merged = exp.params;
    await writeJsonPath(file, store);
  });
  return { experimentId, params: merged };
}

/**
 * Log an artifact reference (name, description, size).
 */
export async function logArtifact({ experimentId, name, description, sizeBytes } = {}) {
  if (!experimentId) throw new Error("experimentId is required");
  if (typeof name !== "string" || !name.trim()) throw new Error("name is required");
  const ws = await resolveWorkspace(experimentId);
  if (!ws) throw new Error(`experiment ${experimentId} not found`);
  const file = workspacePath(ws);
  const artifact = {
    id: randomUUID(),
    name: name.trim(),
    description: description ? String(description) : "",
    sizeBytes: typeof sizeBytes === "number" && Number.isFinite(sizeBytes) ? sizeBytes : null,
    timestamp: Date.now(),
  };
  await withPathLock(file, async () => {
    const store = await readStore(ws);
    const exp = store.experiments[experimentId];
    if (!exp) throw new Error(`experiment ${experimentId} not found`);
    const artifacts = Array.isArray(exp.artifacts) ? exp.artifacts : [];
    artifacts.push(artifact);
    if (artifacts.length > MAX_ARTIFACTS) artifacts.splice(0, artifacts.length - MAX_ARTIFACTS);
    exp.artifacts = artifacts;
    exp.updatedAt = Date.now();
    await writeJsonPath(file, store);
  });
  return artifact;
}

export async function getExperiment(id) {
  if (!id) return null;
  const ws = await resolveWorkspace(id);
  if (!ws) return null;
  const store = await readStore(ws);
  return store.experiments[id] || null;
}

export async function listExperiments(workspaceId) {
  const ws = sanitizeId(workspaceId);
  const store = await readStore(ws);
  return Object.values(store.experiments).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * Compare experiments by their latest metric values.
 * Returns a table: rows = metric names, columns = experiment IDs.
 *
 * @param {string[]} ids
 * @returns {Promise<{ experiments: object[], metrics: string[], table: Record<string, Record<string, number|null>> }>}
 */
export async function compareExperiments(ids) {
  if (!Array.isArray(ids) || !ids.length) {
    return { experiments: [], metrics: [], table: {} };
  }
  const loaded = [];
  for (const id of ids) {
    const exp = await getExperiment(id);
    if (exp) loaded.push(exp);
  }
  const metricSet = new Set();
  for (const exp of loaded) {
    const metrics = exp.metrics && typeof exp.metrics === "object" ? exp.metrics : {};
    for (const m of Object.keys(metrics)) metricSet.add(m);
  }
  const metrics = Array.from(metricSet).sort();
  const table = {};
  for (const m of metrics) {
    table[m] = {};
    for (const exp of loaded) {
      const series = Array.isArray(exp.metrics?.[m]) ? exp.metrics[m] : [];
      table[m][exp.id] = series.length ? series[series.length - 1].value : null;
    }
  }
  return {
    experiments: loaded.map((e) => ({ id: e.id, name: e.name, tags: e.tags })),
    metrics,
    table,
  };
}

export async function _reset(workspaceId) {
  if (workspaceId) {
    await writeJsonPath(workspacePath(workspaceId), { experiments: {} });
    return;
  }
  const idx = await readJsonPath(indexPath(), { workspaces: [], ids: {} });
  const list = Array.isArray(idx.workspaces) ? idx.workspaces : [];
  for (const ws of list) {
    await writeJsonPath(workspacePath(ws), { experiments: {} });
  }
  await writeJsonPath(indexPath(), { workspaces: [], ids: {} });
}

export const _internals = { sanitizeId, workspacePath, indexPath };
