// @ts-check
/**
 * Phase 57.1: DAG pipeline engine.
 *
 * Airflow-style data pipeline engine with dependency ordering,
 * retry/backoff, per-task timeouts, cancellation, and durable run
 * history. Tasks are executed via injectable handler functions keyed
 * on a `type` field, so the module has zero external deps.
 *
 * Exports:
 *   - createPipeline(spec)
 *   - runPipeline(pipelineId, inputs)
 *   - getPipelineStatus(runId)
 *   - cancelRun(runId)
 *   - listRuns(pipelineId?)
 *   - registerHandler(type, fn)
 *
 * @module data-pipeline
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
  return join(getDataDir(), "data-pipeline.json");
}

function now() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/** @type {Record<string, (input: any, ctx: any) => Promise<any>>} */
const _handlers = {
  noop: async (input) => input,
  identity: async (input) => input,
  // Sum all upstream results if they are numbers.
  sum: async (input) => {
    const arr = Array.isArray(input?.upstream) ? input.upstream : [];
    return arr.reduce((a, b) => a + (Number(b) || 0), 0);
  },
  concat: async (input) => {
    const arr = Array.isArray(input?.upstream) ? input.upstream : [];
    return arr.map(String).join("");
  },
  fail: async () => {
    throw new Error("task configured to fail");
  },
};

/**
 * Register or override a task handler.
 * @param {string} type
 * @param {(input: any, ctx: any) => Promise<any>} fn
 */
export function registerHandler(type, fn) {
  if (!type || typeof type !== "string") throw new Error("type required");
  if (typeof fn !== "function") throw new Error("fn must be a function");
  _handlers[type] = fn;
}

/* -------------------------------------------------------------------------- */
/* Run control                                                                */
/* -------------------------------------------------------------------------- */

const _runControl = new Map(); // runId -> { cancelled: boolean }

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    pipelines: {},
    runs: {},
  });
  if (!raw || typeof raw !== "object") {
    return { version: STORE_VERSION, pipelines: {}, runs: {} };
  }
  if (!raw.pipelines || typeof raw.pipelines !== "object") raw.pipelines = {};
  if (!raw.runs || typeof raw.runs !== "object") raw.runs = {};
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    pipelines: store.pipelines || {},
    runs: store.runs || {},
  });
}

/* -------------------------------------------------------------------------- */
/* Pipeline CRUD                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Validate DAG-ness: no cycles, no dangling dependencies.
 * @param {Array<{id: string, deps?: string[]}>} tasks
 */
function validateDag(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const d of t.deps || []) {
      if (!ids.has(d)) throw new Error(`unknown dep "${d}" in task "${t.id}"`);
    }
  }
  // Kahn's algorithm cycle detection
  const inDeg = new Map();
  for (const t of tasks) inDeg.set(t.id, 0);
  for (const t of tasks) {
    for (const _ of t.deps || []) inDeg.set(t.id, (inDeg.get(t.id) || 0) + 1);
  }
  const queue = [];
  for (const [id, deg] of inDeg.entries()) if (deg === 0) queue.push(id);
  let processed = 0;
  while (queue.length > 0) {
    const cur = queue.shift();
    processed += 1;
    for (const t of tasks) {
      if ((t.deps || []).includes(cur)) {
        inDeg.set(t.id, (inDeg.get(t.id) || 0) - 1);
        if (inDeg.get(t.id) === 0) queue.push(t.id);
      }
    }
  }
  if (processed !== tasks.length) throw new Error("pipeline DAG contains a cycle");
}

/**
 * Create and persist a pipeline.
 * @param {object} spec
 */
export async function createPipeline(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec required");
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    throw new Error("tasks array required");
  }
  const tasks = spec.tasks.map((t, i) => ({
    id: t.id ? String(t.id) : `task_${i}`,
    type: t.type ? String(t.type) : "noop",
    deps: Array.isArray(t.deps) ? t.deps.map((d) => String(d)) : [],
    params: t.params && typeof t.params === "object" ? t.params : {},
    retries: Number.isFinite(t.retries) ? Math.max(0, Math.floor(t.retries)) : 0,
    timeoutMs: Number.isFinite(t.timeoutMs) && t.timeoutMs > 0 ? Math.floor(t.timeoutMs) : 30_000,
  }));
  // Ensure unique ids
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new Error(`duplicate task id "${t.id}"`);
    seen.add(t.id);
  }
  validateDag(tasks);
  const pipeline = {
    id: randomId("pl"),
    name: typeof spec.name === "string" && spec.name.trim() ? spec.name.trim() : "pipeline",
    tasks,
    createdAt: now(),
    version: 1,
  };
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.pipelines[pipeline.id] = pipeline;
    await saveStore(store);
  });
  return pipeline;
}

/** List all pipelines. */
export async function listPipelines() {
  const store = await loadStore();
  return Object.values(store.pipelines || {}).map((p) => ({
    id: p.id,
    name: p.name,
    taskCount: (p.tasks || []).length,
    createdAt: p.createdAt,
  }));
}

/* -------------------------------------------------------------------------- */
/* Topological sort                                                           */
/* -------------------------------------------------------------------------- */

function topoSort(tasks) {
  const order = [];
  const inDeg = new Map();
  for (const t of tasks) inDeg.set(t.id, 0);
  for (const t of tasks) {
    for (const _ of t.deps || []) inDeg.set(t.id, (inDeg.get(t.id) || 0) + 1);
  }
  const ready = [];
  for (const [id, deg] of inDeg.entries()) if (deg === 0) ready.push(id);
  while (ready.length > 0) {
    const cur = ready.shift();
    order.push(cur);
    for (const t of tasks) {
      if ((t.deps || []).includes(cur)) {
        inDeg.set(t.id, (inDeg.get(t.id) || 0) - 1);
        if (inDeg.get(t.id) === 0) ready.push(t.id);
      }
    }
  }
  return order;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

async function runTaskWithTimeout(task, input, ctx) {
  const fn = _handlers[task.type];
  if (!fn) throw new Error(`no handler for task type "${task.type}"`);
  let attempt = 0;
  while (true) {
    const start = Date.now();
    try {
      const exec = Promise.resolve().then(() => fn(input, ctx));
      const timer = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`task "${task.id}" timed out after ${task.timeoutMs}ms`)),
          task.timeoutMs).unref?.();
      });
      const result = await Promise.race([exec, timer]);
      return { result, attempt, durationMs: Date.now() - start };
    } catch (err) {
      if (attempt >= (task.retries || 0)) {
        throw err;
      }
      attempt += 1;
    }
  }
}

/**
 * Execute a pipeline and persist the run.
 * @param {string} pipelineId
 * @param {object} [inputs]
 */
export async function runPipeline(pipelineId, inputs = {}) {
  if (!pipelineId) throw new Error("pipelineId required");
  const store = await loadStore();
  const pipeline = store.pipelines[pipelineId];
  if (!pipeline) throw new Error(`pipeline "${pipelineId}" not found`);
  const runId = randomId("run");
  const startedAt = now();
  const order = topoSort(pipeline.tasks);
  _runControl.set(runId, { cancelled: false });

  /** @type {Record<string, any>} */
  const results = {};
  /** @type {Array<{id: string, status: string, attempt?: number, durationMs?: number, error?: string, startedAt: string, finishedAt?: string}>} */
  const taskRuns = [];
  let status = "running";

  // Persist "running" state up front so clients can poll.
  const run = {
    id: runId,
    pipelineId,
    status,
    startedAt,
    finishedAt: null,
    inputs: inputs && typeof inputs === "object" ? inputs : {},
    results,
    taskRuns,
    error: null,
    version: 1,
  };
  await withPathLock(storePath(), async () => {
    const s = await loadStore();
    s.runs[runId] = run;
    await saveStore(s);
  });

  try {
    for (const id of order) {
      if (_runControl.get(runId)?.cancelled) {
        status = "cancelled";
        break;
      }
      const task = pipeline.tasks.find((t) => t.id === id);
      const upstream = (task.deps || []).map((d) => results[d]);
      const input = { params: task.params, upstream, inputs };
      const tStart = now();
      try {
        const { result, attempt, durationMs } = await runTaskWithTimeout(task, input, { runId });
        results[id] = result;
        taskRuns.push({
          id,
          status: "success",
          attempt,
          durationMs,
          startedAt: tStart,
          finishedAt: now(),
        });
      } catch (err) {
        taskRuns.push({
          id,
          status: "failed",
          error: err?.message || String(err),
          startedAt: tStart,
          finishedAt: now(),
        });
        status = "failed";
        run.error = err?.message || String(err);
        break;
      }
    }
    if (status === "running") status = "success";
  } finally {
    run.status = status;
    run.finishedAt = now();
    run.results = results;
    run.taskRuns = taskRuns;
    await withPathLock(storePath(), async () => {
      const s = await loadStore();
      s.runs[runId] = run;
      await saveStore(s);
    });
    _runControl.delete(runId);
  }
  return run;
}

/**
 * Read a run by id.
 * @param {string} runId
 */
export async function getPipelineStatus(runId) {
  if (!runId) throw new Error("runId required");
  const store = await loadStore();
  return store.runs[runId] || null;
}

/**
 * Cancel an in-progress run.
 * @param {string} runId
 */
export async function cancelRun(runId) {
  if (!runId) throw new Error("runId required");
  const ctl = _runControl.get(runId);
  if (ctl) ctl.cancelled = true;
  // Also update the persisted record so polled status reflects it.
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const run = store.runs[runId];
    if (!run) return null;
    if (run.status === "running") {
      run.status = "cancelling";
    }
    store.runs[runId] = run;
    await saveStore(store);
    return run;
  });
}

/**
 * List runs (optionally filtered by pipelineId).
 * @param {string} [pipelineId]
 */
export async function listRuns(pipelineId) {
  const store = await loadStore();
  const all = Object.values(store.runs || {});
  if (pipelineId) return all.filter((r) => r.pipelineId === pipelineId);
  return all;
}
