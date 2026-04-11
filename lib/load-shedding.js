// @ts-check
/**
 * Phase 59.2: Load shedding.
 *
 * Priority queue with elastic capacity. When inflight work exceeds the
 * target capacity, `shouldShed` returns true for requests whose priority
 * is below the current shedding threshold. The queue elastically raises
 * capacity under sustained but moderate pressure, and lowers it after
 * quiet periods. Both behaviors are driven by an injectable clock.
 *
 * Priorities:
 *   - P0 = critical (never shed unless capacity = 0)
 *   - P1 = normal
 *   - P2 = best-effort (shed first)
 *
 * The module exposes:
 *   - `enqueueRequest(req, opts?)`
 *   - `dequeueRequest(opts?)`
 *   - `shouldShed(priority, opts?)`
 *   - `setCapacity(n)`
 *   - `getQueueStats()`
 *
 * @module load-shedding
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const VALID_PRIORITIES = new Set(["P0", "P1", "P2"]);

function statePath() {
  return join(getDataDir(), "load-shedding-state.json");
}

/* -------------------------------------------------------------------------- */
/* In-memory queue                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} QueuedRequest
 * @property {string} id
 * @property {string} priority
 * @property {any} payload
 * @property {number} enqueuedAt
 */

/** @type {QueuedRequest[]} */
const queue = [];

let _counter = 0;
function nextId() {
  _counter += 1;
  return `req-${Date.now().toString(36)}-${_counter}`;
}

/* -------------------------------------------------------------------------- */
/* Config persistence                                                         */
/* -------------------------------------------------------------------------- */

async function loadConfig() {
  const data = await readJsonPath(statePath(), {
    version: STORE_VERSION,
    capacity: 100,
    minCapacity: 10,
    maxCapacity: 500,
    elasticStep: 10,
    shedCounts: { P0: 0, P1: 0, P2: 0 },
  });
  if (!data.shedCounts) data.shedCounts = { P0: 0, P1: 0, P2: 0 };
  return data;
}

async function saveConfig(data) {
  await writeJsonPath(statePath(), {
    version: STORE_VERSION,
    capacity: data.capacity,
    minCapacity: data.minCapacity,
    maxCapacity: data.maxCapacity,
    elasticStep: data.elasticStep,
    shedCounts: data.shedCounts,
    updatedAt: new Date().toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Enqueue a new request. Shedding is enforced before the request
 * lands in the queue; callers should honor the `shed` flag.
 *
 * @param {{ priority?: string, payload?: any }} req
 * @param {{ clock?: () => number }} [opts]
 * @returns {Promise<{ shed: boolean, reason?: string, request?: QueuedRequest, depth: number, capacity: number }>}
 */
export async function enqueueRequest(req, opts = {}) {
  const priority = VALID_PRIORITIES.has(req?.priority) ? req.priority : "P1";
  const clock = typeof opts.clock === "function" ? opts.clock : Date.now;

  const config = await loadConfig();
  const shed = shouldShedInternal(priority, queue.length, config);
  if (shed) {
    config.shedCounts[priority] = (config.shedCounts[priority] || 0) + 1;
    await withPathLock(statePath(), async () => {
      const fresh = await loadConfig();
      fresh.shedCounts[priority] = (fresh.shedCounts[priority] || 0) + 1;
      await saveConfig(fresh);
    });
    return {
      shed: true,
      reason: `shed ${priority} at depth ${queue.length}/${config.capacity}`,
      depth: queue.length,
      capacity: config.capacity,
    };
  }

  const request = {
    id: nextId(),
    priority,
    payload: req?.payload ?? null,
    enqueuedAt: clock(),
  };
  queue.push(request);
  queue.sort((a, b) => a.priority.localeCompare(b.priority));

  // Elastic capacity bump if we've been comfortably saturated under max.
  if (queue.length > config.capacity && config.capacity < config.maxCapacity) {
    const bump = Math.min(config.maxCapacity - config.capacity, config.elasticStep);
    if (bump > 0) {
      config.capacity += bump;
      await withPathLock(statePath(), async () => {
        const fresh = await loadConfig();
        fresh.capacity = Math.min(fresh.maxCapacity, fresh.capacity + bump);
        await saveConfig(fresh);
      });
    }
  }

  return { shed: false, request, depth: queue.length, capacity: config.capacity };
}

/**
 * Pop the highest-priority (lowest P-number) request from the queue.
 * Returns null if the queue is empty.
 *
 * @param {{ clock?: () => number }} [opts]
 * @returns {Promise<QueuedRequest | null>}
 */
export async function dequeueRequest(opts = {}) {
  if (queue.length === 0) return null;
  // Already sorted by priority ascending; shift.
  const req = queue.shift();
  // Elastic capacity shrink when queue drains well below target.
  const config = await loadConfig();
  if (queue.length < Math.floor(config.capacity / 3) && config.capacity > config.minCapacity) {
    const shrink = Math.min(config.capacity - config.minCapacity, config.elasticStep);
    if (shrink > 0) {
      await withPathLock(statePath(), async () => {
        const fresh = await loadConfig();
        fresh.capacity = Math.max(fresh.minCapacity, fresh.capacity - shrink);
        await saveConfig(fresh);
      });
    }
  }
  void opts;
  return req || null;
}

/**
 * Shed decision rules — shared by enqueue and external callers.
 */
function shouldShedInternal(priority, depth, config) {
  const raw = Number(config.capacity);
  const cap = Number.isFinite(raw) ? raw : 100;
  if (cap === 0) return true;
  // P0 never shed unless capacity is 0.
  if (priority === "P0") return false;
  // P2 sheds as soon as queue reaches 75% capacity.
  if (priority === "P2" && depth >= cap * 0.75) return true;
  // P1 sheds only when queue exceeds capacity.
  if (priority === "P1" && depth >= cap) return true;
  return false;
}

/**
 * External check without mutating counters.
 *
 * @param {string} priority
 * @param {{ depth?: number }} [opts]
 */
export async function shouldShed(priority, opts = {}) {
  const p = VALID_PRIORITIES.has(priority) ? priority : "P1";
  const config = await loadConfig();
  const depth = Number.isFinite(opts.depth) ? Number(opts.depth) : queue.length;
  return shouldShedInternal(p, depth, config);
}

/**
 * Manually set capacity. Clamped to [minCapacity, maxCapacity].
 *
 * @param {number} n
 * @returns {Promise<object>}
 */
export async function setCapacity(n) {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error("capacity must be a non-negative number");
  }
  return withPathLock(statePath(), async () => {
    const data = await loadConfig();
    data.capacity = Math.max(0, Math.min(data.maxCapacity, Math.floor(n)));
    await saveConfig(data);
    return data;
  });
}

/**
 * Return the current queue depth, capacity, and shed counters.
 *
 * @returns {Promise<{ depth: number, capacity: number, shedCounts: Record<string, number>, priorityCounts: Record<string, number>, minCapacity: number, maxCapacity: number }>}
 */
export async function getQueueStats() {
  const data = await loadConfig();
  const priorityCounts = { P0: 0, P1: 0, P2: 0 };
  for (const r of queue) {
    priorityCounts[r.priority] = (priorityCounts[r.priority] || 0) + 1;
  }
  return {
    depth: queue.length,
    capacity: data.capacity,
    minCapacity: data.minCapacity,
    maxCapacity: data.maxCapacity,
    shedCounts: data.shedCounts || { P0: 0, P1: 0, P2: 0 },
    priorityCounts,
  };
}

/**
 * Testing utility: drain the queue without honoring capacity elasticity.
 */
export function _resetQueue() {
  queue.length = 0;
}
