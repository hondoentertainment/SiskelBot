/**
 * Phase 29: Event-driven workflow triggers.
 * Register triggers that fire workflows in response to system events.
 * Storage: data/event-triggers/{workspaceId}.json
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_TRIGGERS = 200;

const ALLOWED_EVENTS = new Set([
  "webhook.received",
  "recipe.completed",
  "agent.finished",
  "document.created",
  "conversation.created",
  "schedule.fired",
]);

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function storePath(workspaceId) {
  return join(getDataDir(), "event-triggers", sanitizeWorkspace(workspaceId) + ".json");
}

function normalizeStore(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.triggers)) return raw;
  return { triggers: [] };
}

/**
 * Read a (possibly dotted) path out of an object.
 */
function getByPath(obj, path) {
  if (typeof path !== "string") return undefined;
  let value = obj;
  for (const part of path.split(".")) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Evaluate a single operator condition against a data value.
 * Supported ops: eq, ne, gt, gte, lt, lte, contains, in, exists,
 * and temporal: older_than / newer_than (value = seconds; the data value is
 * treated as an ISO timestamp or epoch ms and compared to now).
 */
function evaluateCondition(cond, dataValue) {
  const op = String(cond.op || "eq").toLowerCase();
  const expected = cond.value;

  switch (op) {
    case "eq":
      return String(dataValue) === String(expected);
    case "ne":
      return String(dataValue) !== String(expected);
    case "gt":
      return Number(dataValue) > Number(expected);
    case "gte":
      return Number(dataValue) >= Number(expected);
    case "lt":
      return Number(dataValue) < Number(expected);
    case "lte":
      return Number(dataValue) <= Number(expected);
    case "contains":
      return typeof dataValue === "string" && dataValue.includes(String(expected));
    case "in":
      return Array.isArray(expected) && expected.map(String).includes(String(dataValue));
    case "exists": {
      const present = dataValue !== undefined && dataValue !== null;
      return expected === false ? !present : present;
    }
    case "older_than":
    case "newer_than": {
      const ts = typeof dataValue === "number" ? dataValue : Date.parse(dataValue);
      if (Number.isNaN(ts)) return false;
      const ageMs = Date.now() - ts;
      const thresholdMs = Number(expected) * 1000;
      if (!Number.isFinite(thresholdMs)) return false;
      return op === "older_than" ? ageMs >= thresholdMs : ageMs < thresholdMs;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a filter expression against event data.
 * Each key must match. A value may be:
 *   - a primitive (string/number/boolean) → equality (backward compatible)
 *   - an object `{ op, value }` → operator condition (gt, contains, older_than, …)
 * Keys may be dotted paths into nested event data.
 * @param {object} filter
 * @param {object} data
 * @returns {boolean}
 */
function evaluateFilter(filter, data) {
  if (!filter || typeof filter !== "object") return true;
  for (const [key, value] of Object.entries(filter)) {
    const dataValue = getByPath(data, key);
    if (value && typeof value === "object" && !Array.isArray(value) && "op" in value) {
      if (!evaluateCondition(value, dataValue)) return false;
      continue;
    }
    if (typeof value === "string" && String(dataValue) !== value) return false;
    if (typeof value === "number" && Number(dataValue) !== value) return false;
    if (typeof value === "boolean" && Boolean(dataValue) !== value) return false;
  }
  return true;
}

export const _internal = { evaluateFilter, evaluateCondition, getByPath };

/**
 * Apply a transform mapping to event data.
 * Transform is an object where keys are output fields and values are dot-path expressions into data.
 * @param {object} transform
 * @param {object} data
 * @returns {object}
 */
function applyTransform(transform, data) {
  if (!transform || typeof transform !== "object") return data;
  const result = {};
  for (const [outKey, path] of Object.entries(transform)) {
    if (typeof path === "string") {
      const parts = path.split(".");
      let value = data;
      for (const part of parts) {
        if (value == null) break;
        value = value[part];
      }
      result[outKey] = value !== undefined ? value : null;
    }
  }
  return result;
}

/**
 * Register a new event trigger.
 * @param {{ workspaceId: string, event: string, workflowId: string, filter?: object, transform?: object, name?: string, description?: string }} config
 * @returns {Promise<object>}
 */
export async function registerTrigger(config) {
  const workspaceId = sanitizeWorkspace(config.workspaceId);
  if (!config.event || !ALLOWED_EVENTS.has(config.event)) {
    throw new Error(`Invalid event. Allowed: ${[...ALLOWED_EVENTS].join(", ")}`);
  }
  if (!config.workflowId || typeof config.workflowId !== "string") {
    throw new Error("workflowId is required");
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  const trigger = {
    id,
    workspaceId,
    event: config.event,
    workflowId: config.workflowId.trim(),
    filter: config.filter && typeof config.filter === "object" ? config.filter : null,
    transform: config.transform && typeof config.transform === "object" ? config.transform : null,
    name: typeof config.name === "string" ? config.name.trim().slice(0, 200) : "",
    description: typeof config.description === "string" ? config.description.trim().slice(0, 1000) : "",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    fireCount: 0,
    lastFiredAt: null,
  };

  const path = storePath(workspaceId);
  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    if (data.triggers.length >= MAX_TRIGGERS) {
      throw new Error("Maximum number of triggers reached");
    }
    data.triggers.push(trigger);
    await writeJsonPath(path, data);
  });

  return trigger;
}

/**
 * Remove a trigger by ID.
 * @param {string} workspaceId
 * @param {string} triggerId
 * @returns {Promise<boolean>}
 */
export async function removeTrigger(workspaceId, triggerId) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  let removed = false;

  await withPathLock(path, async () => {
    const data = normalizeStore(await readJsonPath(path, null));
    const before = data.triggers.length;
    data.triggers = data.triggers.filter((t) => t.id !== triggerId);
    if (data.triggers.length < before) {
      removed = true;
      await writeJsonPath(path, data);
    }
  });

  return removed;
}

/**
 * List all triggers for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<object[]>}
 */
export async function listTriggers(workspaceId) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  const data = normalizeStore(await readJsonPath(path, null));
  return data.triggers;
}

/**
 * Get a single trigger by ID.
 * @param {string} workspaceId
 * @param {string} triggerId
 * @returns {Promise<object|null>}
 */
export async function getTrigger(workspaceId, triggerId) {
  const ws = sanitizeWorkspace(workspaceId);
  const path = storePath(ws);
  const data = normalizeStore(await readJsonPath(path, null));
  return data.triggers.find((t) => t.id === triggerId) || null;
}

/**
 * Fire a trigger event. Matches event to registered triggers, applies
 * filter and transform, then executes associated workflows.
 * @param {string} event - The event name
 * @param {object} data - The event payload
 * @param {{ workspaceId?: string, executeWorkflow?: Function }} opts
 * @returns {Promise<{ matched: number, executed: number, results: object[] }>}
 */
export async function fireTrigger(event, data, opts = {}) {
  const workspaceId = sanitizeWorkspace(opts.workspaceId || "default");
  const path = storePath(workspaceId);
  const store = normalizeStore(await readJsonPath(path, null));

  const matching = store.triggers.filter(
    (t) => t.enabled && t.event === event
  );

  const results = [];
  let executed = 0;

  for (const trigger of matching) {
    // Apply filter
    if (trigger.filter && !evaluateFilter(trigger.filter, data)) {
      continue;
    }

    // Apply transform
    const transformedData = trigger.transform ? applyTransform(trigger.transform, data) : data;

    let result = { triggerId: trigger.id, workflowId: trigger.workflowId, status: "skipped" };

    try {
      if (typeof opts.executeWorkflow === "function") {
        const workflowResult = await opts.executeWorkflow(trigger.workflowId, {
          variables: transformedData,
          triggeredBy: `trigger:${trigger.id}`,
          input: transformedData,
          workspaceId,
        });
        result = { triggerId: trigger.id, workflowId: trigger.workflowId, status: "executed", workflowResult };
      } else {
        result = { triggerId: trigger.id, workflowId: trigger.workflowId, status: "dry-run", data: transformedData };
      }
      executed++;
    } catch (err) {
      result = { triggerId: trigger.id, workflowId: trigger.workflowId, status: "error", error: err.message };
    }

    results.push(result);

    // Update fire count
    await withPathLock(path, async () => {
      const data_ = normalizeStore(await readJsonPath(path, null));
      const t = data_.triggers.find((t_) => t_.id === trigger.id);
      if (t) {
        t.fireCount = (t.fireCount || 0) + 1;
        t.lastFiredAt = new Date().toISOString();
        await writeJsonPath(path, data_);
      }
    });
  }

  return { matched: matching.length, executed, results };
}

/**
 * Get the set of allowed event names.
 * @returns {string[]}
 */
export function getAllowedEvents() {
  return [...ALLOWED_EVENTS];
}
