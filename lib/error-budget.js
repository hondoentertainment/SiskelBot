// @ts-check
/**
 * Phase 59.5: Error budget enforcement.
 *
 * Service-Level Objective (SLO) tracker. An SLO declares a target
 * success rate (e.g. 99.9%) over a rolling window (e.g. 30 days).
 * The error budget is `(1 - target) * total_requests` — the number
 * of failed requests the system can absorb without violating the
 * SLO.
 *
 * This module owns:
 *   - persistence of SLO definitions
 *   - rolling event counts (success/failure) per SLO
 *   - computing remaining budget and exhaustion status
 *
 * Consumers decide what to do when `isBudgetExhausted` returns true
 * (e.g. gate a canary rollout, trigger brownout).
 *
 * The module exposes:
 *   - `defineSlo(spec)`
 *   - `recordEvent(sloId, success, opts?)`
 *   - `getBudgetRemaining(sloId)`
 *   - `isBudgetExhausted(sloId)`
 *   - `listSlos()`
 *
 * @module error-budget
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

function slosPath() {
  return join(getDataDir(), "error-budget-slos.json");
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(slosPath(), {
    version: STORE_VERSION,
    slos: {},
  });
  if (!data.slos || typeof data.slos !== "object") data.slos = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(slosPath(), {
    version: STORE_VERSION,
    slos: data.slos || {},
    updatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Define                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SloSpec
 * @property {string} id
 * @property {string} name
 * @property {number} target             Target success rate (0..1), e.g. 0.999.
 * @property {number} windowSeconds      Rolling window duration.
 * @property {string} [description]
 * @property {number} [minSample]        Minimum sample size before exhaustion can fire.
 */

/**
 * @typedef {Object} Slo
 * @property {number} version
 * @property {string} id
 * @property {string} name
 * @property {number} target
 * @property {number} windowSeconds
 * @property {number} minSample
 * @property {string} description
 * @property {Array<{ at: number, success: boolean }>} events
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Create or update an SLO.
 *
 * @param {SloSpec} spec
 * @returns {Promise<Slo>}
 */
export async function defineSlo(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is required");
  if (!spec.id || typeof spec.id !== "string") throw new Error("id is required");
  if (!spec.name || typeof spec.name !== "string") throw new Error("name is required");
  if (!Number.isFinite(spec.target) || spec.target <= 0 || spec.target >= 1) {
    throw new Error("target must be a number strictly between 0 and 1");
  }
  if (!Number.isFinite(spec.windowSeconds) || spec.windowSeconds <= 0) {
    throw new Error("windowSeconds must be a positive number");
  }
  const path = slosPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const existing = data.slos[spec.id] || {
      version: STORE_VERSION,
      id: spec.id,
      events: [],
      createdAt: now,
    };
    /** @type {Slo} */
    const rec = {
      ...existing,
      id: spec.id,
      name: spec.name,
      target: Number(spec.target),
      windowSeconds: Math.floor(Number(spec.windowSeconds)),
      minSample: Number.isFinite(spec.minSample) && spec.minSample > 0
        ? Math.floor(spec.minSample)
        : existing.minSample ?? 100,
      description: typeof spec.description === "string" ? spec.description : existing.description ?? "",
      events: Array.isArray(existing.events) ? existing.events : [],
      updatedAt: now,
    };
    data.slos[spec.id] = rec;
    await saveStore(data);
    return rec;
  });
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Record a success/failure event for an SLO. Events outside the
 * rolling window are pruned.
 *
 * @param {string} sloId
 * @param {boolean} success
 * @param {{ clock?: () => number }} [opts]
 * @returns {Promise<Slo>}
 */
export async function recordEvent(sloId, success, opts = {}) {
  if (!sloId || typeof sloId !== "string") throw new Error("sloId is required");
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const path = slosPath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const slo = data.slos[sloId];
    if (!slo) throw new Error(`unknown slo: ${sloId}`);
    slo.events = Array.isArray(slo.events) ? slo.events : [];
    const now = clock();
    slo.events.push({ at: now, success: Boolean(success) });
    // Prune events older than window.
    const cutoff = now - slo.windowSeconds * 1000;
    slo.events = slo.events.filter((e) => e.at >= cutoff);
    // Cap event array size to avoid unbounded growth (keep latest 10k).
    if (slo.events.length > 10000) {
      slo.events = slo.events.slice(-10000);
    }
    slo.updatedAt = new Date(now).toISOString();
    data.slos[sloId] = slo;
    await saveStore(data);
    return slo;
  });
}

/* -------------------------------------------------------------------------- */
/* Budget                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compute the remaining error budget for an SLO, within the current
 * rolling window.
 *
 * @param {string} sloId
 * @param {{ clock?: () => number }} [opts]
 * @returns {Promise<{ id: string, target: number, total: number, failures: number, allowed: number, remaining: number, successRate: number, windowSeconds: number }>}
 */
export async function getBudgetRemaining(sloId, opts = {}) {
  if (!sloId || typeof sloId !== "string") throw new Error("sloId is required");
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;
  const data = await loadStore();
  const slo = data.slos[sloId];
  if (!slo) throw new Error(`unknown slo: ${sloId}`);
  const now = clock();
  const cutoff = now - slo.windowSeconds * 1000;
  const events = (slo.events || []).filter((e) => e.at >= cutoff);
  const total = events.length;
  const failures = events.filter((e) => !e.success).length;
  // Round to avoid float drift before flooring (e.g. 0.1 * 10 = 0.9999…).
  const allowed = Math.floor(Math.round((1 - slo.target) * total * 1e6) / 1e6);
  const remaining = allowed - failures;
  const successRate = total > 0 ? (total - failures) / total : 1;
  return {
    id: slo.id,
    target: slo.target,
    total,
    failures,
    allowed,
    remaining,
    successRate: Math.round(successRate * 10000) / 10000,
    windowSeconds: slo.windowSeconds,
  };
}

/**
 * Return true if the SLO's error budget is exhausted (remaining <= 0)
 * provided the minimum sample size has been met.
 *
 * @param {string} sloId
 * @param {{ clock?: () => number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function isBudgetExhausted(sloId, opts = {}) {
  const data = await loadStore();
  const slo = data.slos[sloId];
  if (!slo) return false;
  const budget = await getBudgetRemaining(sloId, opts);
  if (budget.total < (slo.minSample || 0)) return false;
  return budget.remaining <= 0;
}

/**
 * List every configured SLO with a snapshot of current budget.
 */
export async function listSlos() {
  const data = await loadStore();
  const out = [];
  for (const slo of Object.values(data.slos || {})) {
    try {
      const budget = await getBudgetRemaining(slo.id);
      out.push({ ...slo, budget });
    } catch (_err) {
      out.push(slo);
    }
  }
  return out;
}
