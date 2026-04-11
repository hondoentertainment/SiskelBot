// @ts-check
/**
 * Phase 59.4: Canary + traffic shift.
 *
 * Automatic progressive rollouts. A canary has a baseline version
 * ("stable"), a candidate version ("canary"), and a traffic curve
 * (e.g. 1% → 5% → 25% → 50% → 100%). On each call to `tickCanary`
 * the module inspects health metrics and either advances one step
 * toward 100% or rolls back to 0% if the candidate is unhealthy.
 *
 * Metrics are supplied via a pluggable `healthCheck` function so
 * tests can simulate good/bad deployments deterministically.
 *
 * The module exposes:
 *   - `createCanary(spec)`
 *   - `tickCanary(id, metrics?, opts?)`
 *   - `rollbackCanary(id, reason?)`
 *   - `getCanaryStatus(id)`
 *   - `listCanaries()`
 *
 * @module canary
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const DEFAULT_STEPS = [1, 5, 25, 50, 100];

function canariesPath() {
  return join(getDataDir(), "canaries.json");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(canariesPath(), {
    version: STORE_VERSION,
    canaries: {},
  });
  if (!data.canaries || typeof data.canaries !== "object") data.canaries = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(canariesPath(), {
    version: STORE_VERSION,
    canaries: data.canaries || {},
    updatedAt: new Date().toISOString(),
  });
}

let _canaryCounter = 0;
function generateCanaryId(clock) {
  _canaryCounter += 1;
  const ts = typeof clock === "function" ? clock() : Date.now();
  return `canary-${ts.toString(36)}-${_canaryCounter}`;
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} CanarySpec
 * @property {string} name
 * @property {string} stable
 * @property {string} candidate
 * @property {number[]} [steps]          Percent increments (monotonic).
 * @property {number} [errorRateFloor]   Rollback threshold (0..1). Default 0.05.
 * @property {number} [minSuccessCount]  Required successful ticks per step. Default 3.
 * @property {string} [id]
 * @property {() => number} [clock]
 */

/**
 * @typedef {Object} Canary
 * @property {string} id
 * @property {string} name
 * @property {string} stable
 * @property {string} candidate
 * @property {number[]} steps
 * @property {number} stepIndex
 * @property {number} currentPercent
 * @property {number} errorRateFloor
 * @property {number} minSuccessCount
 * @property {number} successCount
 * @property {string} status           pending | running | completed | rolled-back | failed
 * @property {Array<object>} history
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Create a canary rollout plan.
 *
 * @param {CanarySpec} spec
 * @returns {Promise<Canary>}
 */
export async function createCanary(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.name || typeof spec.name !== "string") throw new Error("name is required");
  if (!spec.stable || typeof spec.stable !== "string") throw new Error("stable is required");
  if (!spec.candidate || typeof spec.candidate !== "string") throw new Error("candidate is required");

  const steps = Array.isArray(spec.steps) && spec.steps.length > 0
    ? spec.steps.map((s) => Math.max(0, Math.min(100, Math.floor(Number(s))))).filter((n) => Number.isFinite(n))
    : DEFAULT_STEPS.slice();
  // Enforce monotonic non-decreasing and ending at 100.
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i] < steps[i - 1]) steps[i] = steps[i - 1];
  }
  if (steps[steps.length - 1] < 100) steps.push(100);

  const path = canariesPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const id = spec.id || generateCanaryId(spec.clock);
    const now = new Date().toISOString();
    /** @type {Canary} */
    const canary = {
      id,
      name: spec.name,
      stable: spec.stable,
      candidate: spec.candidate,
      steps,
      stepIndex: 0,
      currentPercent: 0,
      errorRateFloor: Number.isFinite(spec.errorRateFloor)
        ? Math.max(0, Math.min(1, Number(spec.errorRateFloor)))
        : 0.05,
      minSuccessCount: Number.isFinite(spec.minSuccessCount) && spec.minSuccessCount > 0
        ? Math.floor(spec.minSuccessCount)
        : 3,
      successCount: 0,
      status: "pending",
      history: [{ at: now, action: "created", stepIndex: 0, percent: 0 }],
      createdAt: now,
      updatedAt: now,
    };
    data.canaries[id] = canary;
    await saveStore(data);
    return canary;
  });
}

/* -------------------------------------------------------------------------- */
/* Tick                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Advance one tick of the canary state machine. Given the latest
 * metrics the canary will either:
 *   - enter `running` at step 0 (if pending)
 *   - accumulate success counts toward the current step
 *   - advance to the next step when `minSuccessCount` is met
 *   - auto-rollback if `errorRate > errorRateFloor`
 *   - transition to `completed` when step index reaches 100%
 *
 * @param {string} id
 * @param {{ errorRate?: number, latencyMs?: number }} [metrics]
 * @param {{ clock?: () => number }} [opts]
 * @returns {Promise<Canary>}
 */
export async function tickCanary(id, metrics = {}, opts = {}) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const path = canariesPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const c = data.canaries[id];
    if (!c) throw new Error(`unknown canary: ${id}`);
    if (c.status === "completed" || c.status === "rolled-back" || c.status === "failed") {
      return c;
    }

    const now = new Date(clock()).toISOString();
    if (c.status === "pending") {
      c.status = "running";
      c.currentPercent = c.steps[0] ?? 0;
      c.history.push({ at: now, action: "start", stepIndex: 0, percent: c.currentPercent });
    }

    const errorRate = Number(metrics?.errorRate) || 0;
    if (errorRate > c.errorRateFloor) {
      c.status = "rolled-back";
      c.currentPercent = 0;
      c.history.push({
        at: now,
        action: "rollback",
        reason: `errorRate ${errorRate} > floor ${c.errorRateFloor}`,
        stepIndex: c.stepIndex,
      });
      c.successCount = 0;
      c.updatedAt = now;
      data.canaries[id] = c;
      await saveStore(data);
      return c;
    }

    c.successCount += 1;
    if (c.successCount >= c.minSuccessCount) {
      c.successCount = 0;
      if (c.stepIndex + 1 < c.steps.length) {
        c.stepIndex += 1;
        c.currentPercent = c.steps[c.stepIndex];
        c.history.push({
          at: now,
          action: "advance",
          stepIndex: c.stepIndex,
          percent: c.currentPercent,
        });
      }
      if (c.currentPercent >= 100) {
        c.status = "completed";
        c.history.push({ at: now, action: "complete", stepIndex: c.stepIndex, percent: 100 });
      }
    }
    c.updatedAt = now;
    if (c.history.length > 500) c.history = c.history.slice(-500);
    data.canaries[id] = c;
    await saveStore(data);
    return c;
  });
}

/* -------------------------------------------------------------------------- */
/* Rollback                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Force a canary to roll back to 0% and mark it as rolled-back.
 *
 * @param {string} id
 * @param {string} [reason]
 */
export async function rollbackCanary(id, reason) {
  if (!id || typeof id !== "string") throw new Error("id is required");
  const path = canariesPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const c = data.canaries[id];
    if (!c) throw new Error(`unknown canary: ${id}`);
    const now = new Date().toISOString();
    c.status = "rolled-back";
    c.currentPercent = 0;
    c.successCount = 0;
    c.history.push({
      at: now,
      action: "manual-rollback",
      reason: typeof reason === "string" ? reason : "manual",
      stepIndex: c.stepIndex,
    });
    c.updatedAt = now;
    data.canaries[id] = c;
    await saveStore(data);
    return c;
  });
}

/**
 * Fetch a single canary by id.
 *
 * @param {string} id
 * @returns {Promise<Canary | null>}
 */
export async function getCanaryStatus(id) {
  if (!id || typeof id !== "string") return null;
  const data = await loadStore();
  return data.canaries[id] || null;
}

/**
 * List all canaries.
 *
 * @returns {Promise<Canary[]>}
 */
export async function listCanaries() {
  const data = await loadStore();
  return Object.values(data.canaries || {});
}
