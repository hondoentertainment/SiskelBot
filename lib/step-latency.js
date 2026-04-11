// @ts-check
/**
 * Phase 60.3: Step-level latency.
 *
 * Per-cortex / per-tool latency breakdown. Each step is a record:
 *   { cortex, tool, durationMs, startedAt, traceId, status }
 *
 * The store persists recent steps (bounded) and exposes aggregates:
 *   - getBreakdown()  -- totals grouped by cortex + tool
 *   - getPercentiles() -- p50/p90/p95/p99 per bucket
 *   - listTraces()    -- recent traces with grouped steps
 *
 * Export surface:
 *   - recordStep(step)
 *   - getBreakdown({ groupBy?, filter? })
 *   - getPercentiles({ groupBy?, filter? })
 *   - listTraces({ limit?, filter? })
 *   - clearStats()
 *
 * @module step-latency
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_STEPS = 5000;

function storePath() {
  return join(getDataDir(), "step-latency.json");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(storePath(), { version: STORE_VERSION, steps: [] });
  if (!Array.isArray(data.steps)) data.steps = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    steps: Array.isArray(data.steps) ? data.steps.slice(-MAX_STEPS) : [],
  });
}

/* -------------------------------------------------------------------------- */
/* Record                                                                    */
/* -------------------------------------------------------------------------- */

let _counter = 0;
function genId(prefix = "step") {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter}`;
}

/**
 * Record a single completed step.
 *
 * @param {{ cortex?: string, tool?: string, durationMs?: number, traceId?: string, status?: string, metadata?: object, startedAt?: string }} step
 */
export async function recordStep(step) {
  if (!step || typeof step !== "object") {
    throw new Error("step record is required");
  }
  const cortex = typeof step.cortex === "string" && step.cortex.trim() ? step.cortex : "unknown";
  const tool = typeof step.tool === "string" && step.tool.trim() ? step.tool : "unknown";
  const durationMs = Number(step.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("durationMs must be a non-negative number");
  }
  const traceId = typeof step.traceId === "string" && step.traceId.trim() ? step.traceId : genId("trace");
  const status = typeof step.status === "string" ? step.status : "ok";
  const startedAt = typeof step.startedAt === "string" ? step.startedAt : new Date().toISOString();
  const metadata = step.metadata && typeof step.metadata === "object" ? step.metadata : {};

  const record = {
    id: genId(),
    cortex,
    tool,
    durationMs,
    traceId,
    status,
    startedAt,
    recordedAt: new Date().toISOString(),
    metadata,
  };

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    data.steps.push(record);
    if (data.steps.length > MAX_STEPS) {
      data.steps.splice(0, data.steps.length - MAX_STEPS);
    }
    await saveStore(data);
    return record;
  });
}

/* -------------------------------------------------------------------------- */
/* Query helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{ cortex?: string, tool?: string, status?: string, traceId?: string, sinceMs?: number }} StepFilter
 */

/**
 * Apply a filter to a list of steps.
 *
 * @param {any[]} steps
 * @param {StepFilter} [filter]
 */
export function filterSteps(steps, filter = {}) {
  if (!Array.isArray(steps)) return [];
  let out = steps;
  if (filter && typeof filter === "object") {
    if (filter.cortex) out = out.filter((s) => s.cortex === filter.cortex);
    if (filter.tool) out = out.filter((s) => s.tool === filter.tool);
    if (filter.status) out = out.filter((s) => s.status === filter.status);
    if (filter.traceId) out = out.filter((s) => s.traceId === filter.traceId);
    if (Number.isFinite(filter.sinceMs) && filter.sinceMs > 0) {
      const cutoff = Date.now() - filter.sinceMs;
      out = out.filter((s) => {
        const t = Date.parse(s.startedAt || s.recordedAt || "") || 0;
        return t >= cutoff;
      });
    }
  }
  return out;
}

/**
 * Group steps by a key. Valid groupBy values: "cortex", "tool", "cortex:tool".
 *
 * @param {any[]} steps
 * @param {string} groupBy
 * @returns {Map<string, any[]>}
 */
export function groupSteps(steps, groupBy = "cortex:tool") {
  /** @type {Map<string, any[]>} */
  const groups = new Map();
  for (const s of steps) {
    let key;
    if (groupBy === "cortex") key = s.cortex;
    else if (groupBy === "tool") key = s.tool;
    else key = `${s.cortex}:${s.tool}`;
    const arr = groups.get(key) || [];
    arr.push(s);
    groups.set(key, arr);
  }
  return groups;
}

/**
 * Aggregate statistics for an array of step durations.
 *
 * @param {number[]} durations
 */
export function aggregateDurations(durations) {
  const arr = (durations || []).filter((d) => Number.isFinite(d)).slice().sort((a, b) => a - b);
  if (arr.length === 0) {
    return { count: 0, total: 0, min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const total = arr.reduce((a, b) => a + b, 0);
  const mean = total / arr.length;
  const pct = (p) => {
    const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(p * arr.length)));
    return arr[idx];
  };
  return {
    count: arr.length,
    total: Math.round(total * 1000) / 1000,
    min: arr[0],
    max: arr[arr.length - 1],
    mean: Math.round(mean * 1000) / 1000,
    p50: pct(0.5),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Return totals grouped by cortex / tool.
 *
 * @param {{ groupBy?: string, filter?: StepFilter }} [opts]
 */
export async function getBreakdown(opts = {}) {
  const data = await loadStore();
  const filtered = filterSteps(data.steps, opts.filter);
  const groups = groupSteps(filtered, opts.groupBy || "cortex:tool");
  const rows = [];
  for (const [key, steps] of groups.entries()) {
    const durations = steps.map((s) => Number(s.durationMs) || 0);
    const agg = aggregateDurations(durations);
    const errorCount = steps.filter((s) => s.status && s.status !== "ok").length;
    rows.push({
      key,
      count: agg.count,
      total: agg.total,
      mean: agg.mean,
      min: agg.min,
      max: agg.max,
      errorCount,
      errorRate: agg.count > 0 ? Math.round((errorCount / agg.count) * 10000) / 10000 : 0,
    });
  }
  rows.sort((a, b) => b.total - a.total);
  return {
    rows,
    totalSteps: filtered.length,
    groupBy: opts.groupBy || "cortex:tool",
  };
}

/**
 * Percentiles grouped by cortex / tool.
 *
 * @param {{ groupBy?: string, filter?: StepFilter }} [opts]
 */
export async function getPercentiles(opts = {}) {
  const data = await loadStore();
  const filtered = filterSteps(data.steps, opts.filter);
  const groups = groupSteps(filtered, opts.groupBy || "cortex:tool");
  const rows = [];
  for (const [key, steps] of groups.entries()) {
    const durations = steps.map((s) => Number(s.durationMs) || 0);
    const agg = aggregateDurations(durations);
    rows.push({
      key,
      count: agg.count,
      p50: agg.p50,
      p90: agg.p90,
      p95: agg.p95,
      p99: agg.p99,
      mean: agg.mean,
      max: agg.max,
    });
  }
  rows.sort((a, b) => b.p95 - a.p95);
  return { rows, groupBy: opts.groupBy || "cortex:tool" };
}

/**
 * List recent traces (grouped by traceId) with their constituent steps.
 *
 * @param {{ limit?: number, filter?: StepFilter }} [opts]
 */
export async function listTraces(opts = {}) {
  const data = await loadStore();
  const filtered = filterSteps(data.steps, opts.filter);
  /** @type {Map<string, any[]>} */
  const byTrace = new Map();
  for (const step of filtered) {
    const arr = byTrace.get(step.traceId) || [];
    arr.push(step);
    byTrace.set(step.traceId, arr);
  }
  const traces = [...byTrace.entries()].map(([traceId, steps]) => {
    const sortedSteps = steps.slice().sort((a, b) => {
      const ta = Date.parse(a.startedAt || "") || 0;
      const tb = Date.parse(b.startedAt || "") || 0;
      return ta - tb;
    });
    const totalMs = sortedSteps.reduce((acc, s) => acc + (Number(s.durationMs) || 0), 0);
    const startedAt = sortedSteps[0]?.startedAt || null;
    return {
      traceId,
      startedAt,
      totalMs: Math.round(totalMs * 1000) / 1000,
      stepCount: sortedSteps.length,
      steps: sortedSteps,
    };
  });
  traces.sort((a, b) => {
    const ta = Date.parse(a.startedAt || "") || 0;
    const tb = Date.parse(b.startedAt || "") || 0;
    return tb - ta;
  });
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  return { traces: traces.slice(0, limit), total: traces.length };
}

/**
 * Drop every recorded step.
 */
export async function clearStats() {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const count = data.steps.length;
    data.steps = [];
    await saveStore(data);
    return { cleared: count };
  });
}
