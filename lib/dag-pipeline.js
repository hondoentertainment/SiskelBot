/**
 * Phase 57.1: DAG pipeline engine.
 *
 * Airflow-style DAG runner. A pipeline is a named collection of nodes where
 * each node declares its upstream dependencies, an executor (named "task"),
 * a per-node retry policy, and an optional timeout. Nodes run when all
 * upstream dependencies have succeeded.
 *
 * Storage (via json-path-store):
 *   data/dag-pipelines/{pipelineId}.json — pipeline definition
 *   data/dag-pipelines/runs/{runId}.json — run state + per-node results
 *   data/dag-pipelines/_index.json        — pipeline + run index
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const NODE_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
  RETRYING: "retrying",
});

export const RUN_STATUS = Object.freeze({
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
});

// Registered task executors keyed by name.
const TASK_REGISTRY = new Map();

/**
 * Register a task executor. An executor is an async function that receives
 * `(ctx, upstreamResults)` and returns any value (stored in node result).
 */
export function registerTask(name, fn) {
  if (!name || typeof name !== "string") throw new Error("task name required");
  if (typeof fn !== "function") throw new Error("task fn must be a function");
  TASK_REGISTRY.set(name, fn);
}

export function listTasks() {
  return Array.from(TASK_REGISTRY.keys());
}

function sanitizeId(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "default";
}

function pipelinePath(id) {
  return join(getDataDir(), "dag-pipelines", `${sanitizeId(id)}.json`);
}

function runPath(id) {
  return join(getDataDir(), "dag-pipelines", "runs", `${sanitizeId(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "dag-pipelines", "_index.json");
}

// ─── Pipeline CRUD ────────────────────────────────────────────────────────

/**
 * Create a pipeline.
 *
 * @param {{ id?: string, name: string, nodes: Array<{ id: string, task: string, deps?: string[], params?: object, retries?: number, timeoutMs?: number }> }} def
 */
export async function createPipeline(def) {
  if (!def || typeof def !== "object") throw new Error("pipeline def required");
  if (!def.name || typeof def.name !== "string") throw new Error("name is required");
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) {
    throw new Error("at least one node is required");
  }
  const id = def.id || randomUUID();
  const nodes = def.nodes.map((n) => normalizeNode(n));
  validateDag(nodes);
  const record = {
    id,
    name: def.name,
    nodes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonPath(pipelinePath(id), record);
  await touchIndex({ pipelineId: id, name: def.name });
  return record;
}

function normalizeNode(n) {
  if (!n || typeof n !== "object") throw new Error("node must be an object");
  if (!n.id) throw new Error("each node needs an id");
  if (!n.task) throw new Error(`node ${n.id} needs a task`);
  return {
    id: String(n.id),
    task: String(n.task),
    deps: Array.isArray(n.deps) ? n.deps.map(String) : [],
    params: n.params && typeof n.params === "object" ? n.params : {},
    retries: Number.isInteger(n.retries) && n.retries >= 0 ? n.retries : 0,
    timeoutMs: Number.isInteger(n.timeoutMs) && n.timeoutMs > 0 ? n.timeoutMs : 0,
  };
}

function validateDag(nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const d of n.deps) {
      if (!ids.has(d)) throw new Error(`node ${n.id} depends on unknown node ${d}`);
    }
  }
  // Cycle detection via DFS.
  const state = new Map();
  function visit(id) {
    const s = state.get(id);
    if (s === "visiting") throw new Error(`cycle detected involving ${id}`);
    if (s === "done") return;
    state.set(id, "visiting");
    const n = nodes.find((x) => x.id === id);
    for (const d of n.deps) visit(d);
    state.set(id, "done");
  }
  for (const n of nodes) visit(n.id);
}

export async function getPipeline(id) {
  if (!id) return null;
  const rec = await readJsonPath(pipelinePath(id), null);
  if (!rec || !rec.id || rec._deleted) return null;
  return rec;
}

export async function listPipelines() {
  const idx = await readJsonPath(indexPath(), { pipelines: [], runs: [] });
  const pipelines = Array.isArray(idx.pipelines) ? idx.pipelines : [];
  const out = [];
  for (const p of pipelines) {
    const rec = await getPipeline(p.pipelineId);
    if (rec) out.push(rec);
  }
  return out;
}

export async function deletePipeline(id) {
  const rec = await getPipeline(id);
  if (!rec) return { ok: false };
  await writeJsonPath(pipelinePath(id), { _deleted: true });
  return { ok: true };
}

async function touchIndex(entry) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { pipelines: [], runs: [] });
    if (entry.pipelineId) {
      idx.pipelines = (idx.pipelines || []).filter((p) => p.pipelineId !== entry.pipelineId);
      idx.pipelines.push({ pipelineId: entry.pipelineId, name: entry.name });
    }
    if (entry.runId) {
      idx.runs = (idx.runs || []).filter((r) => r.runId !== entry.runId);
      idx.runs.push({ runId: entry.runId, pipelineId: entry.pipelineId, at: new Date().toISOString() });
    }
    await writeJsonPath(indexPath(), idx);
  });
}

// ─── Pipeline execution ──────────────────────────────────────────────────

/**
 * Run a pipeline. Executors must be registered via registerTask.
 *
 * @param {string} pipelineId
 * @param {{ context?: object, runId?: string, timeoutMs?: number }} [options]
 * @returns {Promise<object>} run record
 */
export async function runPipeline(pipelineId, options = {}) {
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) {
    const err = new Error(`pipeline ${pipelineId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const runId = options.runId || randomUUID();
  const context = options.context || {};
  const now = new Date().toISOString();
  const nodeStates = {};
  for (const n of pipeline.nodes) {
    nodeStates[n.id] = {
      status: NODE_STATUS.PENDING,
      attempts: 0,
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
    };
  }
  const run = {
    runId,
    pipelineId,
    status: RUN_STATUS.RUNNING,
    context,
    nodes: nodeStates,
    startedAt: now,
    endedAt: null,
    error: null,
  };
  await writeJsonPath(runPath(runId), run);
  await touchIndex({ runId, pipelineId });

  // Topological execution with level-by-level parallelism.
  const order = topologicalLevels(pipeline.nodes);
  const results = {};

  try {
    for (const level of order) {
      await Promise.all(level.map(async (nodeId) => {
        const node = pipeline.nodes.find((n) => n.id === nodeId);
        const upstream = {};
        let anyUpstreamFailed = false;
        for (const d of node.deps) {
          if (nodeStates[d].status !== NODE_STATUS.SUCCEEDED) anyUpstreamFailed = true;
          upstream[d] = results[d];
        }
        if (anyUpstreamFailed) {
          nodeStates[nodeId].status = NODE_STATUS.SKIPPED;
          nodeStates[nodeId].endedAt = new Date().toISOString();
          await writeJsonPath(runPath(runId), run);
          return;
        }
        await executeNode(node, nodeStates[nodeId], context, upstream, runId, run, results);
      }));
    }
    const allOk = Object.values(nodeStates).every((s) => s.status === NODE_STATUS.SUCCEEDED || s.status === NODE_STATUS.SKIPPED);
    const anySucceeded = Object.values(nodeStates).some((s) => s.status === NODE_STATUS.SUCCEEDED);
    const anyFailed = Object.values(nodeStates).some((s) => s.status === NODE_STATUS.FAILED);
    run.status = anyFailed ? RUN_STATUS.FAILED : (allOk && anySucceeded ? RUN_STATUS.SUCCEEDED : RUN_STATUS.FAILED);
  } catch (err) {
    run.status = RUN_STATUS.FAILED;
    run.error = err.message;
  }
  run.endedAt = new Date().toISOString();
  await writeJsonPath(runPath(runId), run);
  return run;
}

async function executeNode(node, state, context, upstream, runId, run, results) {
  const task = TASK_REGISTRY.get(node.task);
  const maxAttempts = node.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    state.attempts = attempt;
    state.status = attempt > 1 ? NODE_STATUS.RETRYING : NODE_STATUS.RUNNING;
    state.startedAt = state.startedAt || new Date().toISOString();
    await writeJsonPath(runPath(runId), run);
    try {
      if (!task) throw new Error(`task ${node.task} not registered`);
      const ctx = { ...context, nodeId: node.id, params: node.params, runId };
      const promise = task(ctx, upstream);
      let result;
      if (node.timeoutMs > 0) {
        result = await Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`node ${node.id} timed out after ${node.timeoutMs}ms`)), node.timeoutMs)),
        ]);
      } else {
        result = await promise;
      }
      state.status = NODE_STATUS.SUCCEEDED;
      state.result = result ?? null;
      state.endedAt = new Date().toISOString();
      results[node.id] = result;
      await writeJsonPath(runPath(runId), run);
      return;
    } catch (err) {
      state.error = err?.message || String(err);
      if (attempt >= maxAttempts) {
        state.status = NODE_STATUS.FAILED;
        state.endedAt = new Date().toISOString();
        await writeJsonPath(runPath(runId), run);
        return;
      }
    }
  }
}

function topologicalLevels(nodes) {
  const levels = [];
  const done = new Set();
  const remaining = new Set(nodes.map((n) => n.id));
  while (remaining.size > 0) {
    const current = [];
    for (const id of remaining) {
      const n = nodes.find((x) => x.id === id);
      if (n.deps.every((d) => done.has(d))) current.push(id);
    }
    if (current.length === 0) throw new Error("unable to resolve DAG (cycle?)");
    for (const id of current) {
      remaining.delete(id);
      done.add(id);
    }
    levels.push(current);
  }
  return levels;
}

export async function getRunStatus(runId) {
  const rec = await readJsonPath(runPath(runId), null);
  if (!rec || !rec.runId) {
    const err = new Error(`run ${runId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return rec;
}

export async function listRuns() {
  const idx = await readJsonPath(indexPath(), { pipelines: [], runs: [] });
  const entries = Array.isArray(idx.runs) ? idx.runs : [];
  const out = [];
  for (const e of entries) {
    try { out.push(await getRunStatus(e.runId)); } catch (_) { /* missing */ }
  }
  return out;
}

/**
 * Test helper: reset registered tasks.
 */
export function _resetRegistry() {
  TASK_REGISTRY.clear();
}

export const _internals = { topologicalLevels, validateDag, normalizeNode };
