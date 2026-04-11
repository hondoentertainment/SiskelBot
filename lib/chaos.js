// @ts-check
/**
 * Phase 59.1: Chaos engineering.
 *
 * Fault-injection framework for SiskelBot. Operators register "faults"
 * that apply to named targets (endpoints, modules, model ids, ...). A
 * fault specifies a type (`latency`, `error`, `drop`, `partial`) and a
 * probability; when code invokes `injectFault(target, ctx)` the module
 * decides whether to apply the fault and returns a directive that the
 * caller honors.
 *
 * All randomness and wall-clock access are injectable so chaos
 * experiments are deterministic in tests.
 *
 * Types:
 *   - `latency`  — inject an artificial delay (ms)
 *   - `error`    — throw a simulated error
 *   - `drop`     — instruct caller to drop the request
 *   - `partial`  — instruct caller to return a partial/truncated response
 *
 * The module exposes:
 *   - `registerFault(spec)`
 *   - `injectFault(target, ctx, opts?)`
 *   - `removeFault(faultId)`
 *   - `listActiveFaults(target?)`
 *   - `runChaosExperiment(spec, runner, opts?)`
 *
 * @module chaos
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const ALLOWED_TYPES = new Set(["latency", "error", "drop", "partial"]);

function faultsPath() {
  return join(getDataDir(), "chaos-faults.json");
}

function experimentsPath() {
  return join(getDataDir(), "chaos-experiments.json");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadFaults() {
  const data = await readJsonPath(faultsPath(), {
    version: STORE_VERSION,
    faults: {},
  });
  if (!data.faults || typeof data.faults !== "object") data.faults = {};
  return data;
}

async function saveFaults(data) {
  await writeJsonPath(faultsPath(), {
    version: STORE_VERSION,
    faults: data.faults || {},
    updatedAt: new Date().toISOString(),
  });
}

async function loadExperiments() {
  const data = await readJsonPath(experimentsPath(), {
    version: STORE_VERSION,
    experiments: [],
  });
  if (!Array.isArray(data.experiments)) data.experiments = [];
  return data;
}

async function saveExperiments(data) {
  await writeJsonPath(experimentsPath(), {
    version: STORE_VERSION,
    experiments: data.experiments || [],
    updatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

let _faultCounter = 0;
function generateFaultId(clock) {
  _faultCounter += 1;
  const ts = typeof clock === "function" ? clock() : Date.now();
  return `fault-${ts.toString(36)}-${_faultCounter}`;
}

/**
 * @typedef {Object} FaultSpec
 * @property {string} target          Fault target identifier.
 * @property {"latency"|"error"|"drop"|"partial"} type
 * @property {number} probability     0..1.
 * @property {number} [latencyMs]     For type=latency.
 * @property {string} [errorMessage]  For type=error.
 * @property {number} [partialRatio]  For type=partial (0..1).
 * @property {string} [id]            Optional explicit id.
 * @property {() => number} [clock]   Injectable clock.
 */

/**
 * Register a new fault. Returns the persisted record.
 *
 * @param {FaultSpec} spec
 * @returns {Promise<object>}
 */
export async function registerFault(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.target || typeof spec.target !== "string") {
    throw new Error("target is required");
  }
  if (!ALLOWED_TYPES.has(spec.type)) {
    throw new Error(`type must be one of: ${[...ALLOWED_TYPES].join(", ")}`);
  }
  const probability = Number(spec.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("probability must be between 0 and 1");
  }
  const path = faultsPath();
  return withPathLock(path, async () => {
    const data = await loadFaults();
    const id = spec.id || generateFaultId(spec.clock);
    const now = new Date().toISOString();
    const rec = {
      version: STORE_VERSION,
      id,
      target: spec.target,
      type: spec.type,
      probability,
      latencyMs: Number.isFinite(spec.latencyMs) ? Math.max(0, Math.floor(spec.latencyMs)) : 0,
      errorMessage: typeof spec.errorMessage === "string" ? spec.errorMessage : null,
      partialRatio: Number.isFinite(spec.partialRatio)
        ? Math.max(0, Math.min(1, Number(spec.partialRatio)))
        : 0.5,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    data.faults[id] = rec;
    await saveFaults(data);
    return rec;
  });
}

/* -------------------------------------------------------------------------- */
/* Inject                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether and how to inject a fault for a given target. The
 * returned object always has an `action` field:
 *   - `"none"`    — no fault applied
 *   - `"latency"` — caller should delay `{ delayMs }` ms
 *   - `"error"`   — caller should throw the fault's error
 *   - `"drop"`    — caller should abandon the request
 *   - `"partial"` — caller should truncate output to `{ ratio }`
 *
 * @param {string} target
 * @param {object} [ctx]
 * @param {{ random?: () => number, clock?: () => number }} [opts]
 * @returns {Promise<{ action: string, faultId?: string, delayMs?: number, error?: string, ratio?: number }>}
 */
export async function injectFault(target, ctx = {}, opts = {}) {
  if (!target || typeof target !== "string") return { action: "none" };
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const data = await loadFaults();
  const candidates = Object.values(data.faults).filter(
    (f) => f.active && f.target === target,
  );
  for (const f of candidates) {
    const roll = random();
    if (roll >= f.probability) continue;
    switch (f.type) {
      case "latency":
        return { action: "latency", faultId: f.id, delayMs: f.latencyMs };
      case "error":
        return { action: "error", faultId: f.id, error: f.errorMessage || "chaos error" };
      case "drop":
        return { action: "drop", faultId: f.id };
      case "partial":
        return { action: "partial", faultId: f.id, ratio: f.partialRatio };
      default:
        return { action: "none" };
    }
  }
  void ctx;
  return { action: "none" };
}

/* -------------------------------------------------------------------------- */
/* Removal / listing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Deactivate a fault. Returns the removed record (or null).
 *
 * @param {string} faultId
 * @returns {Promise<object | null>}
 */
export async function removeFault(faultId) {
  if (!faultId || typeof faultId !== "string") return null;
  const path = faultsPath();
  return withPathLock(path, async () => {
    const data = await loadFaults();
    const rec = data.faults[faultId];
    if (!rec) return null;
    delete data.faults[faultId];
    await saveFaults(data);
    return rec;
  });
}

/**
 * List active faults, optionally filtered by target.
 *
 * @param {string} [target]
 * @returns {Promise<object[]>}
 */
export async function listActiveFaults(target) {
  const data = await loadFaults();
  let out = Object.values(data.faults || {}).filter((f) => f.active);
  if (target) out = out.filter((f) => f.target === target);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Experiments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run a chaos experiment: register a temporary fault, execute a
 * runner function multiple times, collect action counts, then
 * automatically remove the fault. The runner receives the fault
 * decision for each iteration.
 *
 * @param {FaultSpec} spec
 * @param {(decision: object, iteration: number) => any | Promise<any>} runner
 * @param {{ iterations?: number, random?: () => number }} [opts]
 * @returns {Promise<{ faultId: string, iterations: number, counts: Record<string, number>, results: any[] }>}
 */
export async function runChaosExperiment(spec, runner, opts = {}) {
  if (typeof runner !== "function") throw new Error("runner is required");
  const iterations = Number.isFinite(opts.iterations) && opts.iterations > 0
    ? Math.floor(opts.iterations)
    : 10;
  const fault = await registerFault(spec);
  /** @type {Record<string, number>} */
  const counts = { none: 0, latency: 0, error: 0, drop: 0, partial: 0 };
  const results = [];
  try {
    for (let i = 0; i < iterations; i += 1) {
      const decision = await injectFault(spec.target, { iteration: i }, { random: opts.random });
      counts[decision.action] = (counts[decision.action] || 0) + 1;
      const r = await runner(decision, i);
      results.push(r);
    }
  } finally {
    await removeFault(fault.id);
  }
  // Persist an experiment summary for audit.
  await withPathLock(experimentsPath(), async () => {
    const data = await loadExperiments();
    data.experiments.push({
      faultId: fault.id,
      target: spec.target,
      type: spec.type,
      iterations,
      counts,
      recordedAt: new Date().toISOString(),
    });
    if (data.experiments.length > 200) {
      data.experiments = data.experiments.slice(-200);
    }
    await saveExperiments(data);
  });
  return { faultId: fault.id, iterations, counts, results };
}

/** Diagnostic: list past experiment summaries. */
export async function listChaosExperiments() {
  const data = await loadExperiments();
  return data.experiments;
}
