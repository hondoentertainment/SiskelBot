/**
 * Phase 59.2: Load shedding with priority queue.
 *
 * Protects the server from overload by admitting requests according to a
 * four-tier priority scheme:
 *   P0 - health/critical (never shed)
 *   P1 - paid/premium traffic
 *   P2 - free traffic
 *   P3 - background/batch work
 *
 * When the in-flight budget is exceeded, the lowest-priority requests are
 * rejected first. Capacity is "elastic": callers can adjust soft/hard
 * ceilings at runtime via `configureShedding`. When an admission is shed
 * an `agent_shed` event object is passed to a registered callback so the
 * caller can forward it via SSE or metrics.
 *
 * Storage layout (via json-path-store):
 *   data/load-shedding/config.json — current policy
 *   data/load-shedding/events.json — ring buffer of shed events
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Priority constants ────────────────────────────────────────────────────

export const PRIORITY_P0 = 0;
export const PRIORITY_P1 = 1;
export const PRIORITY_P2 = 2;
export const PRIORITY_P3 = 3;

export const PRIORITY_LABELS = {
  [PRIORITY_P0]: "P0_health",
  [PRIORITY_P1]: "P1_paid",
  [PRIORITY_P2]: "P2_free",
  [PRIORITY_P3]: "P3_batch",
};

export const DEFAULT_CONFIG = {
  softCapacity: 200,    // comfortable in-flight count
  hardCapacity: 500,    // absolute ceiling
  perPriorityLimits: {
    0: Infinity,        // P0 is unlimited
    1: 400,
    2: 200,
    3: 50,
  },
  enabled: true,
};

const MAX_EVENTS = Number(process.env.LOAD_SHEDDING_MAX_EVENTS) || 1000;

// ─── State ──────────────────────────────────────────────────────────────────

let config = cloneConfig(DEFAULT_CONFIG);
const inFlightByPriority = new Map([
  [0, 0], [1, 0], [2, 0], [3, 0],
]);
let totalInFlight = 0;
let shedEventHook = null;

const stats = {
  admitted: { 0: 0, 1: 0, 2: 0, 3: 0 },
  shed: { 0: 0, 1: 0, 2: 0, 3: 0 },
  reasons: { capacity: 0, per_priority: 0, disabled_priority: 0 },
};

function cloneConfig(c) {
  return {
    softCapacity: Number(c.softCapacity) || 0,
    hardCapacity: Number(c.hardCapacity) || 0,
    perPriorityLimits: { ...(c.perPriorityLimits || {}) },
    enabled: c.enabled !== false,
  };
}

// ─── Path helpers ───────────────────────────────────────────────────────────

function configPath() {
  return join(getDataDir(), "load-shedding", "config.json");
}

function eventsPath() {
  return join(getDataDir(), "load-shedding", "events.json");
}

// ─── Config ─────────────────────────────────────────────────────────────────

/**
 * Update the shedding policy. Partial updates are merged with the current
 * config. Returns the effective config.
 */
export function configureShedding(updates = {}) {
  if (!updates || typeof updates !== "object") {
    throw new Error("updates must be an object");
  }
  const next = cloneConfig(config);
  if (Number.isFinite(Number(updates.softCapacity))) {
    next.softCapacity = Number(updates.softCapacity);
  }
  if (Number.isFinite(Number(updates.hardCapacity))) {
    next.hardCapacity = Number(updates.hardCapacity);
  }
  if (updates.perPriorityLimits && typeof updates.perPriorityLimits === "object") {
    for (const [k, v] of Object.entries(updates.perPriorityLimits)) {
      if (v === null) delete next.perPriorityLimits[k];
      else next.perPriorityLimits[k] = v === Infinity ? Infinity : Number(v);
    }
  }
  if (typeof updates.enabled === "boolean") {
    next.enabled = updates.enabled;
  }
  if (next.hardCapacity < next.softCapacity) {
    next.hardCapacity = next.softCapacity;
  }
  config = next;
  // Fire-and-forget persist. Missing storage should not crash the hot path.
  writeJsonPath(configPath(), config).catch(() => {});
  return cloneConfig(config);
}

/**
 * Load a previously saved config from disk. Safe to call at startup.
 */
export async function loadPersistedConfig() {
  const data = await readJsonPath(configPath(), null);
  if (!data || typeof data !== "object") return cloneConfig(config);
  config = cloneConfig({ ...DEFAULT_CONFIG, ...data });
  return cloneConfig(config);
}

export function getConfig() {
  return cloneConfig(config);
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

/**
 * Register a callback invoked with an `agent_shed` event whenever a request
 * is rejected. The event shape is compatible with the SSE `agent_shed`
 * frame used elsewhere in the codebase.
 */
export function setShedEventHook(fn) {
  shedEventHook = typeof fn === "function" ? fn : null;
}

// ─── Core admission ────────────────────────────────────────────────────────

function normalizePriority(priority) {
  const n = Number(priority);
  if (!Number.isFinite(n)) return PRIORITY_P2;
  if (n <= 0) return PRIORITY_P0;
  if (n >= 3) return PRIORITY_P3;
  return Math.round(n);
}

function recordShedEvent(event) {
  // Bounded ring buffer of events for introspection.
  withPathLock(eventsPath(), async () => {
    const data = await readJsonPath(eventsPath(), { events: [] });
    const list = Array.isArray(data.events) ? data.events : [];
    list.push(event);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    await writeJsonPath(eventsPath(), { events: list });
  }).catch(() => {});
  if (shedEventHook) {
    try {
      shedEventHook(event);
    } catch (_) {
      /* never let hook crash admission */
    }
  }
}

/**
 * Decide whether to admit a request at the given priority. Returns an object
 * describing the decision and a `release()` function that must be called
 * when the request finishes (so in-flight counters stay accurate).
 *
 * Shape: { admitted: boolean, priority, reason?, release() }
 */
export function admit(priority = PRIORITY_P2, context = {}) {
  const p = normalizePriority(priority);

  if (!config.enabled) {
    return markAdmitted(p);
  }

  // P0 is sacred — always admit (health, shutdown, internal probes).
  if (p === PRIORITY_P0) {
    return markAdmitted(p);
  }

  const perPriorityLimit = config.perPriorityLimits?.[p];
  const currentInPriority = inFlightByPriority.get(p) || 0;
  if (Number.isFinite(perPriorityLimit) && currentInPriority >= perPriorityLimit) {
    return shedRequest(p, "per_priority", context, {
      limit: perPriorityLimit,
      current: currentInPriority,
    });
  }

  // Hard ceiling: nobody below P0 gets admitted past this point.
  if (totalInFlight >= config.hardCapacity) {
    return shedRequest(p, "capacity", context, {
      total: totalInFlight,
      hardCapacity: config.hardCapacity,
    });
  }

  // Soft ceiling: shed lowest priority first once we cross it.
  if (totalInFlight >= config.softCapacity) {
    // Only sacrifice P3 at soft; P3 shed triggers when > softCapacity.
    if (p === PRIORITY_P3) {
      return shedRequest(p, "capacity", context, {
        total: totalInFlight,
        softCapacity: config.softCapacity,
      });
    }
    // Shed P2 when we're further above soft and approaching hard.
    const midway = config.softCapacity + (config.hardCapacity - config.softCapacity) * 0.5;
    if (p === PRIORITY_P2 && totalInFlight >= midway) {
      return shedRequest(p, "capacity", context, {
        total: totalInFlight,
        softCapacity: config.softCapacity,
        hardCapacity: config.hardCapacity,
      });
    }
  }

  return markAdmitted(p);
}

function markAdmitted(priority) {
  inFlightByPriority.set(priority, (inFlightByPriority.get(priority) || 0) + 1);
  totalInFlight += 1;
  stats.admitted[priority] += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    inFlightByPriority.set(
      priority,
      Math.max(0, (inFlightByPriority.get(priority) || 0) - 1),
    );
    totalInFlight = Math.max(0, totalInFlight - 1);
  };
  return {
    admitted: true,
    priority,
    label: PRIORITY_LABELS[priority],
    release,
  };
}

function shedRequest(priority, reason, context, extras) {
  stats.shed[priority] += 1;
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  const event = {
    type: "agent_shed",
    at: new Date().toISOString(),
    priority,
    priorityLabel: PRIORITY_LABELS[priority],
    reason,
    totalInFlight,
    capacity: {
      soft: config.softCapacity,
      hard: config.hardCapacity,
    },
    context: context && typeof context === "object" ? context : {},
    ...extras,
  };
  recordShedEvent(event);
  return {
    admitted: false,
    priority,
    label: PRIORITY_LABELS[priority],
    reason,
    event,
    release: () => {},
  };
}

// ─── Express middleware helper ─────────────────────────────────────────────

/**
 * Produce an Express middleware that admits requests at the given priority.
 * Accepts either a number or a function that returns a priority from `req`.
 *
 * Shed responses return HTTP 503 with a JSON body describing the shed event.
 */
export function admitRequest(priorityOrFn = PRIORITY_P2) {
  return function admitMiddleware(req, res, next) {
    const p = typeof priorityOrFn === "function"
      ? priorityOrFn(req)
      : priorityOrFn;
    const decision = admit(p, {
      path: req.path,
      method: req.method,
    });
    if (!decision.admitted) {
      res.setHeader("Retry-After", "1");
      return res.status(503).json({
        error: "load_shed",
        reason: decision.reason,
        priority: decision.priority,
        priorityLabel: decision.label,
      });
    }
    res.on("finish", decision.release);
    res.on("close", decision.release);
    return next();
  };
}

// ─── Stats / reset ──────────────────────────────────────────────────────────

export function getShedStats() {
  return {
    config: cloneConfig(config),
    totalInFlight,
    inFlightByPriority: Object.fromEntries(inFlightByPriority),
    admitted: { ...stats.admitted },
    shed: { ...stats.shed },
    reasons: { ...stats.reasons },
    shedRate: (() => {
      const total = Object.values(stats.admitted).reduce((a, b) => a + b, 0) +
        Object.values(stats.shed).reduce((a, b) => a + b, 0);
      return total === 0 ? 0 : Object.values(stats.shed).reduce((a, b) => a + b, 0) / total;
    })(),
  };
}

/**
 * Read the persisted shed-event ring buffer (newest last).
 */
export async function getShedEvents(limit = 100) {
  const data = await readJsonPath(eventsPath(), { events: [] });
  const list = Array.isArray(data.events) ? data.events : [];
  const n = Number(limit) > 0 ? Number(limit) : 100;
  return list.slice(-n);
}

export function resetShedding() {
  config = cloneConfig(DEFAULT_CONFIG);
  inFlightByPriority.set(0, 0);
  inFlightByPriority.set(1, 0);
  inFlightByPriority.set(2, 0);
  inFlightByPriority.set(3, 0);
  totalInFlight = 0;
  for (const k of Object.keys(stats.admitted)) stats.admitted[k] = 0;
  for (const k of Object.keys(stats.shed)) stats.shed[k] = 0;
  for (const k of Object.keys(stats.reasons)) stats.reasons[k] = 0;
  shedEventHook = null;
}

export const _internals = {
  normalizePriority,
  configPath,
  eventsPath,
};
