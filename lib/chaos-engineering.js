// @ts-check
/**
 * Phase 59.1: Chaos engineering.
 *
 * Fault injection framework for controlled failure testing. Supports:
 *   - Rule-based injection against URL / tool / backend targets.
 *   - Probabilistic fault selection with pluggable parameters.
 *   - Experiment lifecycle: create → start → steady-state metrics → stop → validate.
 *   - Observability: per-fault event history, per-experiment hypothesis validation.
 *
 * Storage is JSON-backed via json-path-store.js so the module works across
 * file, SQLite, or Postgres KV backends without changes.
 *
 * @module chaos-engineering
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Fault types ────────────────────────────────────────────────────────────

/**
 * Catalog of supported fault types. Each fault has a human description and
 * callers drive its behaviour via `params` on a matching rule.
 */
export const FAULT_TYPES = Object.freeze({
  latency: { description: "Add artificial delay" },
  error: { description: "Throw synthetic error" },
  timeout: { description: "Simulate timeout" },
  partial_response: { description: "Return truncated data" },
  rate_limit: { description: "Return 429" },
  network_partition: { description: "Simulate network failure" },
  slow_response: { description: "Drip responses" },
  data_corruption: { description: "Corrupt response bytes" },
});

// ─── In-process state (rules + stats + history) ─────────────────────────────

const STORE_VERSION = 1;
const MAX_FAULT_HISTORY = 5_000;

function experimentsPath() {
  return join(getDataDir(), "chaos", "experiments.json");
}

function faultHistoryPath() {
  return join(getDataDir(), "chaos", "fault-history.json");
}

async function loadExperiments() {
  const data = await readJsonPath(experimentsPath(), { _version: STORE_VERSION, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveExperiments(items) {
  await writeJsonPath(experimentsPath(), { _version: STORE_VERSION, items });
}

async function loadFaultHistory() {
  const data = await readJsonPath(faultHistoryPath(), { _version: STORE_VERSION, events: [] });
  return Array.isArray(data.events) ? data.events : [];
}

async function saveFaultHistory(events) {
  const trimmed = events.length > MAX_FAULT_HISTORY ? events.slice(-MAX_FAULT_HISTORY) : events;
  await writeJsonPath(faultHistoryPath(), { _version: STORE_VERSION, events: trimmed });
}

// ─── ChaosInjector ──────────────────────────────────────────────────────────

/**
 * Holds a list of active injection rules and tracks per-type statistics.
 * Rule matching is cheap so an injector can sit on hot paths.
 */
export class ChaosInjector {
  constructor() {
    /** @type {Map<string, {id:string,type:string,targetPattern:string,probability:number,params:object,enabled:boolean,createdAt:string}>} */
    this._rules = new Map();
    this._stats = { checks: 0, injected: 0, byType: {}, byRule: {} };
  }

  /**
   * Register a rule. `targetPattern` is a substring or regex-literal string.
   * Rules default to enabled=true and probability=1.
   * @param {{id?:string,type:string,targetPattern?:string,probability?:number,params?:object,enabled?:boolean}} rule
   */
  addRule(rule) {
    if (!rule || typeof rule !== "object") throw new Error("rule is required");
    if (!rule.type || !(rule.type in FAULT_TYPES)) {
      throw new Error(`invalid fault type: ${rule.type}`);
    }
    const id = rule.id || randomUUID();
    const probability = rule.probability == null ? 1 : Number(rule.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error("probability must be in [0, 1]");
    }
    const entry = {
      id,
      type: rule.type,
      targetPattern: typeof rule.targetPattern === "string" ? rule.targetPattern : "*",
      probability,
      params: rule.params && typeof rule.params === "object" ? { ...rule.params } : {},
      enabled: rule.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    this._rules.set(id, entry);
    return entry;
  }

  /**
   * Remove a rule by id. Returns true if removed.
   * @param {string} ruleId
   */
  removeRule(ruleId) {
    return this._rules.delete(ruleId);
  }

  /** List registered rules, optionally filtered. */
  listRules(filter = {}) {
    const rules = Array.from(this._rules.values());
    return rules.filter((r) => {
      if (filter.type && r.type !== filter.type) return false;
      if (filter.enabled !== undefined && r.enabled !== Boolean(filter.enabled)) return false;
      return true;
    });
  }

  /**
   * Determine if a context should trigger a fault. Returns the matching rule
   * (after probability roll) or null. Does NOT mutate stats — `applyFault`
   * does. We count a "check" here for steady-state observability.
   *
   * Matching is: enabled AND (pattern === "*" OR target contains pattern OR
   * pattern is a valid regex that matches target).
   *
   * @param {{target?:string, type?:string}} context
   */
  async shouldInject(context) {
    this._stats.checks += 1;
    const target = (context && context.target) || "";
    for (const rule of this._rules.values()) {
      if (!rule.enabled) continue;
      if (context && context.type && context.type !== rule.type) continue;
      if (!this._matchesPattern(rule.targetPattern, target)) continue;
      const roll = Math.random();
      if (roll < rule.probability) return rule;
    }
    return null;
  }

  _matchesPattern(pattern, target) {
    if (!pattern || pattern === "*") return true;
    if (target.includes(pattern)) return true;
    try {
      return new RegExp(pattern).test(target);
    } catch {
      return false;
    }
  }

  /**
   * Apply the configured fault. Depending on type this may delay, throw, or
   * return a mutated payload. The caller supplies `context.data` for data
   * faults. Records a fault event asynchronously (fire-and-forget).
   *
   * @param {object} rule
   * @param {{target?:string,data?:any,experimentId?:string}} [context]
   */
  async applyFault(rule, context = {}) {
    if (!rule || !rule.type) throw new Error("rule with type is required");
    this._stats.injected += 1;
    this._stats.byType[rule.type] = (this._stats.byType[rule.type] || 0) + 1;
    this._stats.byRule[rule.id] = (this._stats.byRule[rule.id] || 0) + 1;

    const params = rule.params || {};
    const event = {
      ruleId: rule.id,
      type: rule.type,
      target: context.target || null,
      experimentId: context.experimentId || null,
      at: new Date().toISOString(),
    };
    // Fire-and-forget persistence so applyFault remains cheap.
    recordFaultEvent(event).catch(() => {});

    switch (rule.type) {
      case "latency": {
        const ms = Math.max(0, Number(params.ms) || 250);
        await injectLatency(ms);
        return context.data;
      }
      case "slow_response": {
        const total = Math.max(1, Number(params.totalMs) || 1_000);
        const drips = Math.max(1, Number(params.drips) || 4);
        await injectLatency(total / drips);
        return context.data;
      }
      case "error": {
        injectError(params.code || "CHAOS_ERROR");
        return; // unreachable
      }
      case "timeout": {
        const err = new Error(params.code || "CHAOS_TIMEOUT");
        /** @type {any} */ (err).code = "ETIMEDOUT";
        throw err;
      }
      case "rate_limit": {
        const err = new Error(params.code || "CHAOS_RATE_LIMIT");
        /** @type {any} */ (err).code = "E_RATE_LIMIT";
        /** @type {any} */ (err).statusCode = 429;
        throw err;
      }
      case "network_partition": {
        const err = new Error(params.code || "CHAOS_NETWORK_PARTITION");
        /** @type {any} */ (err).code = "ECONNRESET";
        throw err;
      }
      case "partial_response": {
        const keep = Number.isFinite(Number(params.keepRatio)) ? Number(params.keepRatio) : 0.5;
        return injectPartialResponse(context.data, keep);
      }
      case "data_corruption": {
        const rate = Number.isFinite(Number(params.rate)) ? Number(params.rate) : 0.1;
        return injectDataCorruption(context.data, rate);
      }
      default:
        throw new Error(`unsupported fault type: ${rule.type}`);
    }
  }

  getStats() {
    return {
      checks: this._stats.checks,
      injected: this._stats.injected,
      byType: { ...this._stats.byType },
      byRule: { ...this._stats.byRule },
      rules: this._rules.size,
    };
  }

  reset() {
    this._rules.clear();
    this._stats = { checks: 0, injected: 0, byType: {}, byRule: {} };
  }
}

// Module-level singleton used by the Express middleware and routes.
let _defaultInjector = null;
/** @returns {ChaosInjector} */
export function getDefaultInjector() {
  if (!_defaultInjector) _defaultInjector = new ChaosInjector();
  return _defaultInjector;
}

// ─── Decorator and middleware ───────────────────────────────────────────────

/**
 * Wrap a function with chaos injection. Before calling the underlying fn,
 * the injector evaluates rules using `options.contextFn(args)` (default:
 * `{ target: args[0] }`). If a rule fires, the fault is applied — which may
 * throw, delay, or mutate the result returned from `fn`.
 *
 * @template {(...args:any[])=>any} F
 * @param {F} fn
 * @param {ChaosInjector} injector
 * @param {{contextFn?:(args:any[])=>object}} [options]
 * @returns {F}
 */
export function withChaos(fn, injector, options = {}) {
  const contextFn = typeof options.contextFn === "function"
    ? options.contextFn
    : (args) => ({ target: typeof args[0] === "string" ? args[0] : "" });
  /** @type {any} */
  const wrapped = async (...args) => {
    const context = contextFn(args) || {};
    const rule = await injector.shouldInject(context);
    if (rule) {
      // For fault types that throw, applyFault throws here.
      // For latency/data-* faults, we apply before/around the call.
      if (["error", "timeout", "rate_limit", "network_partition"].includes(rule.type)) {
        await injector.applyFault(rule, context);
      } else if (["latency", "slow_response"].includes(rule.type)) {
        await injector.applyFault(rule, context);
        return await fn(...args);
      } else {
        const result = await fn(...args);
        return await injector.applyFault(rule, { ...context, data: result });
      }
    }
    return await fn(...args);
  };
  return wrapped;
}

/**
 * Express middleware that may inject faults based on the request URL. The
 * middleware is transparent by default — it only acts when a matching rule
 * fires. Callers can opt-in per-route by mounting the middleware upstream.
 *
 * @param {ChaosInjector} injector
 * @param {{contextFn?:(req:any)=>object}} [options]
 */
export function chaosMiddleware(injector, options = {}) {
  const contextFn = typeof options.contextFn === "function"
    ? options.contextFn
    : (req) => ({ target: req.originalUrl || req.url || "" });
  return async (req, res, next) => {
    try {
      const context = contextFn(req) || {};
      const rule = await injector.shouldInject(context);
      if (!rule) return next();
      try {
        await injector.applyFault(rule, context);
      } catch (err) {
        const status = /** @type {any} */ (err).statusCode || 500;
        const code = /** @type {any} */ (err).code || "CHAOS_FAULT";
        return res.status(status).json({ error: { code, message: err.message, injected: true } });
      }
      return next();
    } catch (_e) {
      // Never break the request pipeline on injector errors.
      return next();
    }
  };
}

// ─── Experiment lifecycle ───────────────────────────────────────────────────

/**
 * Create a new chaos experiment. The experiment starts in status="created"
 * and is persisted; call startExperiment to flip to "running".
 *
 * @param {string} name
 * @param {{faults?:Array,targets?:Array,duration?:number,rampUpMs?:number,steadyStateMs?:number,hypothesis?:object}} [config]
 */
export async function createExperiment(name, config = {}) {
  if (!name || typeof name !== "string") throw new Error("name is required");
  const id = randomUUID();
  const now = new Date().toISOString();
  const experiment = {
    id,
    name: name.trim(),
    status: "created",
    config: {
      faults: Array.isArray(config.faults) ? config.faults : [],
      targets: Array.isArray(config.targets) ? config.targets : [],
      duration: Number.isFinite(Number(config.duration)) ? Number(config.duration) : 60_000,
      rampUpMs: Number.isFinite(Number(config.rampUpMs)) ? Number(config.rampUpMs) : 0,
      steadyStateMs: Number.isFinite(Number(config.steadyStateMs)) ? Number(config.steadyStateMs) : 60_000,
      hypothesis: config.hypothesis || null,
    },
    steadyStateMetrics: [],
    startedAt: null,
    stoppedAt: null,
    createdAt: now,
  };
  await withPathLock(experimentsPath(), async () => {
    const items = await loadExperiments();
    items.push(experiment);
    await saveExperiments(items);
  });
  return experiment;
}

/** Transition an experiment to running and record startedAt. */
export async function startExperiment(experimentId) {
  return await withPathLock(experimentsPath(), async () => {
    const items = await loadExperiments();
    const idx = items.findIndex((e) => e.id === experimentId);
    if (idx < 0) throw new Error("experiment not found");
    if (items[idx].status === "running") return items[idx];
    items[idx].status = "running";
    items[idx].startedAt = new Date().toISOString();
    await saveExperiments(items);
    return items[idx];
  });
}

/** Transition an experiment to stopped and record stoppedAt. */
export async function stopExperiment(experimentId) {
  return await withPathLock(experimentsPath(), async () => {
    const items = await loadExperiments();
    const idx = items.findIndex((e) => e.id === experimentId);
    if (idx < 0) throw new Error("experiment not found");
    items[idx].status = "stopped";
    items[idx].stoppedAt = new Date().toISOString();
    await saveExperiments(items);
    return items[idx];
  });
}

/** Return the experiment or null. */
export async function getExperiment(experimentId) {
  const items = await loadExperiments();
  return items.find((e) => e.id === experimentId) || null;
}

/**
 * List experiments, optionally filtered.
 * @param {{status?:string,name?:string}} [filter]
 */
export async function listExperiments(filter = {}) {
  const items = await loadExperiments();
  return items.filter((e) => {
    if (filter.status && e.status !== filter.status) return false;
    if (filter.name && !e.name.includes(filter.name)) return false;
    return true;
  });
}

// ─── Observability ──────────────────────────────────────────────────────────

/** Append a fault event to the rolling history. */
export async function recordFaultEvent(event) {
  if (!event || typeof event !== "object") throw new Error("event is required");
  const entry = {
    ruleId: event.ruleId || null,
    type: event.type || null,
    target: event.target || null,
    experimentId: event.experimentId || null,
    at: event.at || new Date().toISOString(),
    meta: event.meta || null,
  };
  await withPathLock(faultHistoryPath(), async () => {
    const events = await loadFaultHistory();
    events.push(entry);
    await saveFaultHistory(events);
  });
  return entry;
}

/**
 * Return fault events, optionally scoped to a specific experiment.
 * @param {string|null} [experimentId]
 */
export async function getFaultHistory(experimentId = null) {
  const events = await loadFaultHistory();
  if (!experimentId) return events;
  return events.filter((e) => e.experimentId === experimentId);
}

// ─── Hypothesis / steady-state validation ───────────────────────────────────

/**
 * Record a steady-state metric observed during an experiment.
 * @param {string} experimentId
 * @param {{name:string,value:number,at?:string}} metric
 */
export async function recordSteadyStateMetric(experimentId, metric) {
  if (!metric || typeof metric !== "object" || !metric.name) {
    throw new Error("metric with name is required");
  }
  const entry = {
    name: String(metric.name),
    value: Number(metric.value),
    at: metric.at || new Date().toISOString(),
  };
  return await withPathLock(experimentsPath(), async () => {
    const items = await loadExperiments();
    const idx = items.findIndex((e) => e.id === experimentId);
    if (idx < 0) throw new Error("experiment not found");
    if (!Array.isArray(items[idx].steadyStateMetrics)) items[idx].steadyStateMetrics = [];
    items[idx].steadyStateMetrics.push(entry);
    await saveExperiments(items);
    return entry;
  });
}

/**
 * Validate a hypothesis against recorded steady-state metrics. The hypothesis
 * has the shape `{ metric: string, op: "<"|"<="|">"|">="|"=="|"!=", threshold: number }`.
 * Returns `{ valid, deviation, reason }`.
 *
 * @param {string} experimentId
 * @param {{metric:string,op:string,threshold:number,aggregator?:"avg"|"max"|"min"|"p95"}} hypothesis
 */
export async function validateSteadyState(experimentId, hypothesis) {
  if (!hypothesis || typeof hypothesis !== "object") {
    return { valid: false, deviation: null, reason: "hypothesis is required" };
  }
  const exp = await getExperiment(experimentId);
  if (!exp) return { valid: false, deviation: null, reason: "experiment not found" };
  const metrics = Array.isArray(exp.steadyStateMetrics) ? exp.steadyStateMetrics : [];
  const matching = metrics.filter((m) => m.name === hypothesis.metric);
  if (matching.length === 0) {
    return { valid: false, deviation: null, reason: `no metrics recorded for "${hypothesis.metric}"` };
  }
  const values = matching.map((m) => Number(m.value)).filter((v) => Number.isFinite(v));
  if (values.length === 0) {
    return { valid: false, deviation: null, reason: "no finite values recorded" };
  }
  const agg = aggregate(values, hypothesis.aggregator || "avg");
  const threshold = Number(hypothesis.threshold);
  const op = String(hypothesis.op || ">=");
  const cmp = compare(agg, op, threshold);
  const deviation = agg - threshold;
  return {
    valid: cmp,
    deviation,
    reason: cmp
      ? `hypothesis met: ${hypothesis.metric} ${op} ${threshold} (observed ${agg})`
      : `hypothesis violated: ${hypothesis.metric} ${op} ${threshold} failed (observed ${agg})`,
    observed: agg,
    aggregator: hypothesis.aggregator || "avg",
    samples: values.length,
  };
}

function aggregate(values, aggregator) {
  const sorted = [...values].sort((a, b) => a - b);
  switch (aggregator) {
    case "min": return sorted[0];
    case "max": return sorted[sorted.length - 1];
    case "p95": {
      const i = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
      return sorted[i];
    }
    case "avg":
    default:
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

function compare(a, op, b) {
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: return false;
  }
}

// ─── Built-in fault implementations ─────────────────────────────────────────

/** Delay for `ms` milliseconds. */
export function injectLatency(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/** Throw an error with the given code as message. Named so callers can spy. */
export function injectError(code = "CHAOS_ERROR") {
  const err = new Error(String(code));
  /** @type {any} */ (err).code = String(code);
  throw err;
}

/**
 * Return a truncated copy of the data. `keepRatio` is clamped to [0, 1].
 * Works on strings, arrays, Buffers, Uint8Arrays, and JSON-serializable objects.
 */
export function injectPartialResponse(data, keepRatio = 0.5) {
  const ratio = Math.max(0, Math.min(1, Number(keepRatio)));
  if (data == null) return data;
  if (typeof data === "string") {
    return data.slice(0, Math.floor(data.length * ratio));
  }
  if (Array.isArray(data)) {
    return data.slice(0, Math.floor(data.length * ratio));
  }
  if (Buffer.isBuffer(data)) {
    return data.slice(0, Math.floor(data.length * ratio));
  }
  if (data instanceof Uint8Array) {
    return data.slice(0, Math.floor(data.length * ratio));
  }
  if (typeof data === "object") {
    const keys = Object.keys(data);
    const keep = keys.slice(0, Math.floor(keys.length * ratio));
    const out = {};
    for (const k of keep) out[k] = data[k];
    return out;
  }
  return data;
}

/**
 * Corrupt `rate` fraction of bytes/chars in the data. Rate clamped to [0, 1].
 * Uses a deterministic toggle (xor with 0xFF) for bytes, random char
 * substitution for strings. Returns a new value; inputs are not mutated.
 */
export function injectDataCorruption(data, rate = 0.1) {
  const r = Math.max(0, Math.min(1, Number(rate)));
  if (r === 0 || data == null) return data;
  // Pick `n` unique indexes via Fisher-Yates partial shuffle so repeat picks
  // can never cancel out (e.g. two XORs on the same byte restore it).
  const pickUniqueIndexes = (length, n) => {
    const all = Array.from({ length }, (_, i) => i);
    const count = Math.min(n, length);
    for (let i = 0; i < count; i += 1) {
      const j = i + Math.floor(Math.random() * (length - i));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, count);
  };
  if (typeof data === "string") {
    const chars = data.split("");
    const n = Math.max(1, Math.floor(chars.length * r));
    for (const idx of pickUniqueIndexes(chars.length, n)) {
      chars[idx] = String.fromCharCode((chars[idx].charCodeAt(0) ^ 0x20) & 0x7f);
    }
    return chars.join("");
  }
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
    const copy = Buffer.isBuffer(data) ? Buffer.from(data) : new Uint8Array(data);
    const n = Math.max(1, Math.floor(copy.length * r));
    for (const idx of pickUniqueIndexes(copy.length, n)) {
      copy[idx] = copy[idx] ^ 0xff;
    }
    return copy;
  }
  if (Array.isArray(data)) {
    const copy = [...data];
    const n = Math.max(1, Math.floor(copy.length * r));
    for (const idx of pickUniqueIndexes(copy.length, n)) {
      copy[idx] = null;
    }
    return copy;
  }
  return data;
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset the default injector and in-memory caches. Intended for tests. */
export function _resetForTests() {
  _defaultInjector = null;
}
