/**
 * Phase 39.2: Funnel tracking for conversion analytics.
 *
 * Tracks user progression through ordered funnel steps (e.g., signup -> verify
 * -> first chat). Computes conversion rates, dropoff, and step timing.
 *
 * Storage:
 *   data/funnels/{funnelId}.json          - funnel definition
 *   data/funnels/_index.json              - global index of funnels
 *   data/funnel-events/{date}.json        - daily event log (YYYY-MM-DD)
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock } from "./json-path-store.js";

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function getFunnelPath(funnelId) {
  return join(getDataDir(), "funnels", `${sanitize(funnelId)}.json`);
}

function getFunnelIndexPath() {
  return join(getDataDir(), "funnels", "_index.json");
}

function getEventsPath(dateStr) {
  return join(getDataDir(), "funnel-events", `${sanitize(dateStr)}.json`);
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function defaultWindow() {
  return 7 * 24 * 60 * 60 * 1000; // 7 days
}

/**
 * Pre-defined funnels seeded for the global workspace on first use.
 */
export const PREDEFINED_FUNNELS = {
  signup_to_first_chat: {
    name: "signup_to_first_chat",
    description: "Track signup through first chat completion",
    steps: [
      { name: "signup", event: "signup" },
      { name: "verify", event: "verify" },
      { name: "first_chat", event: "first_chat" },
    ],
    windowMs: 7 * 24 * 60 * 60 * 1000,
  },
  chat_to_upgrade: {
    name: "chat_to_upgrade",
    description: "Track engagement leading to plan upgrade",
    steps: [
      { name: "first_chat", event: "first_chat" },
      { name: "10_chats", event: "10_chats" },
      { name: "plan_view", event: "plan_view" },
      { name: "upgrade", event: "upgrade" },
    ],
    windowMs: 30 * 24 * 60 * 60 * 1000,
  },
  knowledge_adoption: {
    name: "knowledge_adoption",
    description: "Track knowledge base adoption from signup",
    steps: [
      { name: "signup", event: "signup" },
      { name: "add_document", event: "add_document" },
      { name: "search_knowledge", event: "search_knowledge" },
      { name: "use_in_chat", event: "use_in_chat" },
    ],
    windowMs: 30 * 24 * 60 * 60 * 1000,
  },
};

function normalizeStep(step) {
  if (!step || typeof step !== "object") return null;
  const name = typeof step.name === "string" ? step.name.trim() : "";
  const event = typeof step.event === "string" ? step.event.trim() : "";
  if (!name || !event) return null;
  const out = { name, event };
  if (step.condition && typeof step.condition === "object") {
    out.condition = step.condition;
  }
  return out;
}

function matchCondition(condition, metadata) {
  if (!condition || typeof condition !== "object") return true;
  if (!metadata || typeof metadata !== "object") return false;
  for (const [key, expected] of Object.entries(condition)) {
    const actual = metadata[key];
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if (expected.gte != null && !(Number(actual) >= Number(expected.gte))) return false;
      if (expected.lte != null && !(Number(actual) <= Number(expected.lte))) return false;
      if (expected.eq != null && actual !== expected.eq) return false;
      if (expected.in && Array.isArray(expected.in) && !expected.in.includes(actual)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

async function updateIndex(entry, remove = false) {
  const path = getFunnelIndexPath();
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { funnels: [] });
    const list = Array.isArray(data.funnels) ? data.funnels : [];
    const filtered = list.filter((f) => f.id !== entry.id);
    if (!remove) filtered.push(entry);
    await writeJsonPath(path, { funnels: filtered });
  });
}

async function readFunnel(funnelId) {
  const data = await readJsonPath(getFunnelPath(funnelId), null);
  if (!data || !data.id || data._deleted) return null;
  return data;
}

/**
 * Define a new funnel.
 *
 * @param {string} name
 * @param {Array<{name:string, event:string, condition?:object}>} steps
 * @param {{ workspaceId?:string, windowMs?:number, description?:string, id?:string }} [options]
 */
export async function defineFunnel(name, steps, options = {}) {
  if (!name || typeof name !== "string") {
    return { error: "name is required", code: "INVALID_INPUT" };
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    return { error: "steps must be a non-empty array", code: "INVALID_INPUT" };
  }
  const normalized = steps.map(normalizeStep).filter(Boolean);
  if (normalized.length !== steps.length) {
    return { error: "each step requires name and event", code: "INVALID_INPUT" };
  }
  const id = options.id || randomUUID();
  const now = new Date().toISOString();
  const funnel = {
    id,
    name,
    description: typeof options.description === "string" ? options.description : "",
    workspaceId: options.workspaceId || "default",
    windowMs: Number.isFinite(Number(options.windowMs)) ? Number(options.windowMs) : defaultWindow(),
    steps: normalized,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonPath(getFunnelPath(id), funnel);
  await updateIndex({
    id,
    name,
    workspaceId: funnel.workspaceId,
    description: funnel.description,
    stepCount: normalized.length,
    createdAt: now,
  });
  return funnel;
}

/**
 * Track an event that may match funnel steps.
 *
 * @param {string} userId
 * @param {string} event
 * @param {object} [metadata]
 */
export async function trackFunnelEvent(userId, event, metadata = {}) {
  if (!userId || typeof userId !== "string") {
    return { error: "userId is required", code: "INVALID_INPUT" };
  }
  if (!event || typeof event !== "string") {
    return { error: "event is required", code: "INVALID_INPUT" };
  }
  const timestamp = Number.isFinite(Number(metadata?.timestamp))
    ? Number(metadata.timestamp)
    : Date.now();
  const date = dateKey(timestamp);
  const path = getEventsPath(date);
  const record = {
    id: randomUUID(),
    userId,
    event,
    timestamp,
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
  };
  delete record.metadata.timestamp;
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { events: [] });
    const list = Array.isArray(data.events) ? data.events : [];
    list.push(record);
    await writeJsonPath(path, { events: list });
  });
  return { ok: true, id: record.id, timestamp };
}

function inDateRange(ts, dateRange) {
  if (!dateRange) return true;
  if (dateRange.from && ts < new Date(dateRange.from).getTime()) return false;
  if (dateRange.to && ts > new Date(dateRange.to).getTime()) return false;
  return true;
}

function listDatesBetween(from, to) {
  const out = [];
  const start = new Date(dateKey(from));
  const end = new Date(dateKey(to));
  let cursor = start.getTime();
  const endMs = end.getTime();
  let safety = 0;
  while (cursor <= endMs && safety < 10_000) {
    out.push(dateKey(cursor));
    cursor += 24 * 60 * 60 * 1000;
    safety++;
  }
  return out;
}

async function loadEventsInRange(dateRange) {
  const now = Date.now();
  const from = dateRange?.from ? new Date(dateRange.from).getTime() : now - 90 * 24 * 60 * 60 * 1000;
  const to = dateRange?.to ? new Date(dateRange.to).getTime() : now;
  const dates = listDatesBetween(from, to);
  const all = [];
  for (const d of dates) {
    const data = await readJsonPath(getEventsPath(d), { events: [] });
    const list = Array.isArray(data.events) ? data.events : [];
    for (const ev of list) {
      if (ev && ev.timestamp >= from && ev.timestamp <= to) all.push(ev);
    }
  }
  all.sort((a, b) => a.timestamp - b.timestamp);
  return all;
}

/**
 * For a single user, walk through the funnel steps in order. A step matches
 * the earliest event after the previous step's timestamp (or any time for the
 * first step) within the funnel's windowMs from the first matched step.
 *
 * @param {object} funnel
 * @param {Array<object>} userEvents - sorted ascending
 */
function walkFunnelForUser(funnel, userEvents) {
  const reached = []; // [{ step, timestamp }]
  let lastTs = -Infinity;
  let firstTs = null;
  for (const step of funnel.steps) {
    let matched = null;
    for (const ev of userEvents) {
      if (ev.timestamp <= lastTs) continue;
      if (ev.event !== step.event) continue;
      if (!matchCondition(step.condition, ev.metadata)) continue;
      if (firstTs != null && ev.timestamp - firstTs > funnel.windowMs) continue;
      matched = ev;
      break;
    }
    if (!matched) break;
    if (firstTs == null) firstTs = matched.timestamp;
    lastTs = matched.timestamp;
    reached.push({ step: step.name, event: step.event, timestamp: matched.timestamp });
  }
  return reached;
}

/**
 * Compute aggregate funnel stats over a date range.
 *
 * @param {string} funnelId
 * @param {{from?:string|number, to?:string|number}} [dateRange]
 */
export async function getFunnelStats(funnelId, dateRange) {
  const funnel = await readFunnel(funnelId);
  if (!funnel) return { error: "funnel not found", code: "NOT_FOUND" };

  const events = await loadEventsInRange(dateRange);

  // Group events by user
  const byUser = new Map();
  for (const ev of events) {
    let arr = byUser.get(ev.userId);
    if (!arr) {
      arr = [];
      byUser.set(ev.userId, arr);
    }
    arr.push(ev);
  }

  const stepCounts = funnel.steps.map(() => 0);
  const stepTimings = funnel.steps.map(() => []);
  let total = 0;

  for (const userEvents of byUser.values()) {
    const reached = walkFunnelForUser(funnel, userEvents);
    if (reached.length === 0) continue;
    total++;
    for (let i = 0; i < reached.length; i++) {
      stepCounts[i]++;
      if (i > 0) {
        stepTimings[i].push(reached[i].timestamp - reached[i - 1].timestamp);
      }
    }
  }

  const stepsOut = funnel.steps.map((step, i) => {
    const count = stepCounts[i];
    const prev = i === 0 ? total : stepCounts[i - 1];
    const conversionRate = prev > 0 ? count / prev : 0;
    const dropoffRate = prev > 0 ? Math.max(0, prev - count) / prev : 0;
    const timings = stepTimings[i];
    const avgTimeToStep = timings.length
      ? timings.reduce((a, b) => a + b, 0) / timings.length
      : 0;
    return {
      name: step.name,
      event: step.event,
      count,
      conversionRate: Number(conversionRate.toFixed(6)),
      dropoffRate: Number(dropoffRate.toFixed(6)),
      avgTimeToStep: Math.round(avgTimeToStep),
    };
  });

  const finalCount = stepCounts[stepCounts.length - 1] || 0;
  const overallConversion = total > 0 ? finalCount / total : 0;

  return {
    funnelId: funnel.id,
    name: funnel.name,
    steps: stepsOut,
    total,
    overallConversion: Number(overallConversion.toFixed(6)),
    dateRange: dateRange || null,
  };
}

/**
 * Get a single user's path through the funnel.
 *
 * @param {string} funnelId
 * @param {string} userId
 */
export async function getFunnelPathForUser(funnelId, userId) {
  const funnel = await readFunnel(funnelId);
  if (!funnel) return { error: "funnel not found", code: "NOT_FOUND" };
  if (!userId) return { error: "userId is required", code: "INVALID_INPUT" };

  const events = await loadEventsInRange(null);
  const userEvents = events
    .filter((ev) => ev.userId === userId)
    .sort((a, b) => a.timestamp - b.timestamp);
  const reached = walkFunnelForUser(funnel, userEvents);

  return {
    funnelId: funnel.id,
    userId,
    reached,
    completed: reached.length === funnel.steps.length,
    currentStep: reached.length > 0 ? reached[reached.length - 1].step : null,
    progress: funnel.steps.length > 0 ? reached.length / funnel.steps.length : 0,
  };
}

/**
 * List funnels in a workspace (or all workspaces when omitted).
 */
export async function listFunnels(workspaceId) {
  const data = await readJsonPath(getFunnelIndexPath(), { funnels: [] });
  const list = Array.isArray(data.funnels) ? data.funnels : [];
  if (!workspaceId) return list;
  return list.filter((f) => f.workspaceId === workspaceId);
}

/**
 * Delete a funnel by id.
 */
export async function deleteFunnel(funnelId) {
  const funnel = await readFunnel(funnelId);
  if (!funnel) return { error: "funnel not found", code: "NOT_FOUND" };
  await writeJsonPath(getFunnelPath(funnelId), { id: funnelId, _deleted: true });
  await updateIndex({ id: funnelId }, true);
  return { ok: true, id: funnelId };
}

/**
 * Return users who reached `step` (1-indexed) but did NOT continue to the next step.
 *
 * @param {string} funnelId
 * @param {number} step
 * @param {{from?:string|number, to?:string|number}} [dateRange]
 */
export async function getDropoffUsers(funnelId, step, dateRange) {
  const funnel = await readFunnel(funnelId);
  if (!funnel) return { error: "funnel not found", code: "NOT_FOUND" };
  const stepIdx = Number(step);
  if (!Number.isFinite(stepIdx) || stepIdx < 1 || stepIdx > funnel.steps.length) {
    return { error: "invalid step index", code: "INVALID_INPUT" };
  }

  const events = await loadEventsInRange(dateRange);
  const byUser = new Map();
  for (const ev of events) {
    let arr = byUser.get(ev.userId);
    if (!arr) {
      arr = [];
      byUser.set(ev.userId, arr);
    }
    arr.push(ev);
  }

  const dropped = [];
  for (const [userId, userEvents] of byUser.entries()) {
    const reached = walkFunnelForUser(funnel, userEvents);
    // Reached the requested step (1-indexed) but not the next.
    if (reached.length === stepIdx && stepIdx < funnel.steps.length) {
      dropped.push({
        userId,
        lastStep: reached[reached.length - 1].step,
        lastEventAt: reached[reached.length - 1].timestamp,
      });
    } else if (reached.length === stepIdx && stepIdx === funnel.steps.length) {
      // Reached the final step — by definition not dropped.
      continue;
    }
  }

  return {
    funnelId: funnel.id,
    step: stepIdx,
    stepName: funnel.steps[stepIdx - 1].name,
    nextStepName: funnel.steps[stepIdx]?.name || null,
    droppedCount: dropped.length,
    users: dropped,
  };
}

/**
 * Seed pre-defined funnels for a workspace if they don't already exist.
 * Returns the list of funnels created (may be empty).
 */
export async function seedPredefinedFunnels(workspaceId = "default") {
  const existing = await listFunnels(workspaceId);
  const existingNames = new Set(existing.map((f) => f.name));
  const created = [];
  for (const cfg of Object.values(PREDEFINED_FUNNELS)) {
    if (existingNames.has(cfg.name)) continue;
    const f = await defineFunnel(cfg.name, cfg.steps, {
      workspaceId,
      windowMs: cfg.windowMs,
      description: cfg.description,
    });
    if (f && !f.error) created.push(f);
  }
  return created;
}

/**
 * Get a single funnel definition by id.
 */
export async function getFunnel(funnelId) {
  const funnel = await readFunnel(funnelId);
  if (!funnel) return { error: "funnel not found", code: "NOT_FOUND" };
  return funnel;
}

export const __test__ = {
  walkFunnelForUser,
  matchCondition,
  normalizeStep,
  dateKey,
};
