// @ts-check
/**
 * Phase 60.5: Public status page.
 *
 * Customer-facing incident history and component statuses. Provides:
 *   - component registry with health status
 *   - incident timeline with updates
 *   - uptime percentages derived from component transitions
 *
 * Valid component statuses:
 *   operational | degraded | partial-outage | major-outage | maintenance
 *
 * Export surface:
 *   - getStatusPage()
 *   - postIncident(incident)
 *   - updateIncident(id, update)
 *   - resolveIncident(id, note?)
 *   - setComponentStatus(componentId, status, message?)
 *   - listIncidents(filter?)
 *
 * @module status-page
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const VALID_STATUSES = new Set([
  "operational",
  "degraded",
  "partial-outage",
  "major-outage",
  "maintenance",
]);
const VALID_INCIDENT_STATUSES = new Set(["investigating", "identified", "monitoring", "resolved"]);
const VALID_IMPACT = new Set(["none", "minor", "major", "critical"]);

function storePath() {
  return join(getDataDir(), "status-page.json");
}

let _counter = 0;
function genId(prefix) {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter}`;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function emptyStore() {
  return {
    version: STORE_VERSION,
    components: {},
    incidents: [],
    history: [],
  };
}

async function loadStore() {
  const data = await readJsonPath(storePath(), emptyStore());
  if (!data.components || typeof data.components !== "object") data.components = {};
  if (!Array.isArray(data.incidents)) data.incidents = [];
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    components: data.components || {},
    incidents: data.incidents || [],
    history: data.history || [],
  });
}

/* -------------------------------------------------------------------------- */
/* Components                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Set or create a component's status. Records the transition in history
 * so uptime can be computed later.
 *
 * @param {string} componentId
 * @param {string} status
 * @param {string} [message]
 */
export async function setComponentStatus(componentId, status, message) {
  if (!componentId || typeof componentId !== "string") {
    throw new Error("componentId is required");
  }
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`invalid status "${status}"`);
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const existing = data.components[componentId] || {
      id: componentId,
      name: componentId,
      status: "operational",
      createdAt: now,
      updatedAt: now,
    };
    const prevStatus = existing.status;
    existing.status = status;
    existing.updatedAt = now;
    if (typeof message === "string") existing.statusMessage = message;
    data.components[componentId] = existing;
    data.history.push({
      id: genId("hist"),
      componentId,
      from: prevStatus,
      to: status,
      at: now,
      message: typeof message === "string" ? message : undefined,
    });
    // Keep history bounded.
    if (data.history.length > 1000) {
      data.history = data.history.slice(-1000);
    }
    await saveStore(data);
    return existing;
  });
}

/* -------------------------------------------------------------------------- */
/* Incidents                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Create a new incident.
 *
 * @param {{ title: string, description?: string, impact?: string, components?: string[], status?: string }} incident
 */
export async function postIncident(incident) {
  if (!incident || typeof incident !== "object") {
    throw new Error("incident is required");
  }
  if (!incident.title || typeof incident.title !== "string") {
    throw new Error("incident.title is required");
  }
  const impact = typeof incident.impact === "string" ? incident.impact : "minor";
  if (!VALID_IMPACT.has(impact)) {
    throw new Error(`invalid impact "${impact}"`);
  }
  const status = typeof incident.status === "string" ? incident.status : "investigating";
  if (!VALID_INCIDENT_STATUSES.has(status)) {
    throw new Error(`invalid incident status "${status}"`);
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const now = new Date().toISOString();
    const record = {
      id: genId("inc"),
      title: incident.title,
      description: typeof incident.description === "string" ? incident.description : "",
      impact,
      status,
      components: Array.isArray(incident.components) ? incident.components.slice() : [],
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      updates: [
        {
          id: genId("upd"),
          status,
          message: typeof incident.description === "string" ? incident.description : incident.title,
          at: now,
        },
      ],
    };
    data.incidents.push(record);
    await saveStore(data);
    return record;
  });
}

/**
 * Append an update to an incident.
 *
 * @param {string} id
 * @param {{ message?: string, status?: string }} update
 */
export async function updateIncident(id, update) {
  if (!id || typeof id !== "string") {
    throw new Error("incident id is required");
  }
  if (!update || typeof update !== "object") {
    throw new Error("update is required");
  }
  if (update.status && !VALID_INCIDENT_STATUSES.has(update.status)) {
    throw new Error(`invalid incident status "${update.status}"`);
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const incident = data.incidents.find((i) => i.id === id);
    if (!incident) throw new Error(`incident ${id} not found`);
    const now = new Date().toISOString();
    incident.updates.push({
      id: genId("upd"),
      status: update.status || incident.status,
      message: typeof update.message === "string" ? update.message : "",
      at: now,
    });
    if (update.status) incident.status = update.status;
    incident.updatedAt = now;
    await saveStore(data);
    return incident;
  });
}

/**
 * Mark an incident resolved.
 *
 * @param {string} id
 * @param {string} [note]
 */
export async function resolveIncident(id, note) {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const incident = data.incidents.find((i) => i.id === id);
    if (!incident) throw new Error(`incident ${id} not found`);
    const now = new Date().toISOString();
    incident.status = "resolved";
    incident.resolvedAt = now;
    incident.updatedAt = now;
    incident.updates.push({
      id: genId("upd"),
      status: "resolved",
      message: typeof note === "string" ? note : "Incident resolved.",
      at: now,
    });
    await saveStore(data);
    return incident;
  });
}

/**
 * List incidents, optionally filtered.
 *
 * @param {{ status?: string, componentId?: string, sinceDays?: number }} [filter]
 */
export async function listIncidents(filter = {}) {
  const data = await loadStore();
  let out = data.incidents.slice();
  if (filter && typeof filter === "object") {
    if (filter.status) out = out.filter((i) => i.status === filter.status);
    if (filter.componentId) out = out.filter((i) => Array.isArray(i.components) && i.components.includes(filter.componentId));
    if (Number.isFinite(filter.sinceDays) && filter.sinceDays > 0) {
      const cutoff = Date.now() - filter.sinceDays * 24 * 60 * 60 * 1000;
      out = out.filter((i) => (Date.parse(i.createdAt) || 0) >= cutoff);
    }
  }
  out.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Uptime                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compute uptime percentage for one component over the last `days`.
 * Treats "operational" and "maintenance" as healthy.
 *
 * @param {string} componentId
 * @param {any[]} history
 * @param {{ days?: number, now?: number }} [opts]
 */
export function computeUptime(componentId, history, opts = {}) {
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 30;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowStart = now - days * 24 * 60 * 60 * 1000;
  const events = (history || [])
    .filter((h) => h.componentId === componentId)
    .slice()
    .sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  if (events.length === 0) {
    return { componentId, days, uptimePct: 100, downtimeMs: 0 };
  }
  // Starting state: the state "from" of the first event, unless it's later than windowStart.
  let cursor = windowStart;
  let currentState = "operational";
  for (const e of events) {
    const at = Date.parse(e.at) || 0;
    if (at <= windowStart) {
      currentState = e.to;
      continue;
    }
    break;
  }
  let downtime = 0;
  for (const e of events) {
    const at = Date.parse(e.at) || 0;
    if (at <= windowStart) continue;
    if (at > now) break;
    if (isDown(currentState)) downtime += at - cursor;
    cursor = at;
    currentState = e.to;
  }
  if (isDown(currentState)) downtime += now - cursor;
  const totalMs = days * 24 * 60 * 60 * 1000;
  const upMs = Math.max(0, totalMs - downtime);
  const pct = Math.round((upMs / totalMs) * 10000) / 100;
  return { componentId, days, uptimePct: pct, downtimeMs: downtime };
}

function isDown(status) {
  return status === "partial-outage" || status === "major-outage" || status === "degraded";
}

/**
 * Fetch the full public status page payload.
 *
 * @param {{ days?: number }} [opts]
 */
export async function getStatusPage(opts = {}) {
  const data = await loadStore();
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 30;
  const components = Object.values(data.components || {}).map((c) => {
    const uptime = computeUptime(/** @type {any} */ (c).id, data.history, { days });
    return { ...(/** @type {any} */ (c)), uptime };
  });
  const activeIncidents = data.incidents.filter((i) => i.status !== "resolved");
  const recentIncidents = data.incidents
    .filter((i) => {
      const t = Date.parse(i.createdAt) || 0;
      return t >= Date.now() - days * 24 * 60 * 60 * 1000;
    })
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const overall = deriveOverall(components, activeIncidents);
  return {
    _version: STORE_VERSION,
    overall,
    components,
    activeIncidents,
    recentIncidents,
    days,
  };
}

function deriveOverall(components, activeIncidents) {
  if (!Array.isArray(components) || components.length === 0) {
    return "operational";
  }
  let worst = "operational";
  const order = ["operational", "maintenance", "degraded", "partial-outage", "major-outage"];
  for (const c of components) {
    const idx = order.indexOf(c.status);
    const bestIdx = order.indexOf(worst);
    if (idx > bestIdx) worst = c.status;
  }
  if (activeIncidents && activeIncidents.length > 0) {
    const hasCritical = activeIncidents.some((i) => i.impact === "critical");
    if (hasCritical) return "major-outage";
  }
  return worst;
}
