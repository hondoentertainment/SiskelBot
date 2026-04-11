// @ts-check
/**
 * Phase 65.4: Audit report generation.
 *
 * Scheduled compliance reports. A report definition describes a query
 * (type, filter, grouping) plus a cadence. `generateReport` materializes
 * a report given a collection of audit events (which the caller supplies
 * or which come from a hook). Reports are stored JSON-backed; CSV export
 * converts tabular rows.
 *
 * Exports:
 *   - scheduleReport
 *   - generateReport
 *   - listReports
 *   - getReport
 *   - exportCsv
 *   - cancelSchedule
 *   - listSchedules
 *
 * @module audit-reports
 */
import { join } from "path";
import { randomBytes } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const VALID_CADENCES = new Set(["daily", "weekly", "monthly", "quarterly", "on-demand"]);
const VALID_TYPES = new Set(["access", "admin", "policy", "config", "data-export", "all"]);

function storePath() {
  return join(getDataDir(), "audit-reports.json");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    schedules: {},
    reports: {},
  });
  if (!data.schedules || typeof data.schedules !== "object") data.schedules = {};
  if (!data.reports || typeof data.reports !== "object") data.reports = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    schedules: data.schedules || {},
    reports: data.reports || {},
  });
}

/**
 * @typedef {Object} ReportSchedule
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {string} cadence
 * @property {object} filter
 * @property {string} [groupBy]
 * @property {string[]} [recipients]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [lastRunAt]
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} Report
 * @property {string} id
 * @property {string} scheduleId
 * @property {string} name
 * @property {string} type
 * @property {string} generatedAt
 * @property {string} [periodStart]
 * @property {string} [periodEnd]
 * @property {object} summary
 * @property {Array<object>} rows
 */

/**
 * Schedule a recurring report.
 *
 * @param {{name: string, type: string, cadence: string, filter?: object, groupBy?: string, recipients?: string[], enabled?: boolean}} payload
 * @returns {Promise<ReportSchedule>}
 */
export async function scheduleReport(payload) {
  if (!payload || typeof payload !== "object") throw new Error("payload required");
  if (!payload.name) throw new Error("name is required");
  const type = String(payload.type || "all").toLowerCase();
  if (!VALID_TYPES.has(type)) throw new Error(`type must be one of ${[...VALID_TYPES].join(", ")}`);
  const cadence = String(payload.cadence || "on-demand").toLowerCase();
  if (!VALID_CADENCES.has(cadence)) {
    throw new Error(`cadence must be one of ${[...VALID_CADENCES].join(", ")}`);
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const id = newId("sched");
    const ts = nowIso();
    const record = {
      id,
      name: String(payload.name),
      type,
      cadence,
      filter: payload.filter && typeof payload.filter === "object" ? { ...payload.filter } : {},
      groupBy: payload.groupBy ? String(payload.groupBy) : "",
      recipients: Array.isArray(payload.recipients) ? payload.recipients.map(String) : [],
      createdAt: ts,
      updatedAt: ts,
      enabled: payload.enabled !== false,
    };
    data.schedules[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Cancel (disable) a scheduled report.
 * @param {string} id
 */
export async function cancelSchedule(id) {
  if (!id) throw new Error("id required");
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const rec = data.schedules[id];
    if (!rec) throw new Error(`schedule ${id} not found`);
    rec.enabled = false;
    rec.updatedAt = nowIso();
    data.schedules[id] = rec;
    await saveStore(data);
    return rec;
  });
}

/**
 * List all schedules.
 *
 * @param {{enabledOnly?: boolean, type?: string}} [filter]
 * @returns {Promise<ReportSchedule[]>}
 */
export async function listSchedules(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.schedules || {});
  if (filter.enabledOnly) all = all.filter((s) => s.enabled);
  if (filter.type) all = all.filter((s) => s.type === filter.type);
  all.sort((a, b) => (a.name < b.name ? -1 : 1));
  return all;
}

/**
 * Match an audit event against a filter object. Supported filter keys
 * include: type, actor, targetType, outcome, since, until, tags.
 *
 * @param {object} filter
 * @param {object} event
 * @returns {boolean}
 */
export function matchEvent(filter, event) {
  if (!filter || typeof filter !== "object") return true;
  if (!event || typeof event !== "object") return false;
  if (filter.type && filter.type !== "all" && event.type !== filter.type) return false;
  if (filter.actor && event.actor !== filter.actor) return false;
  if (filter.targetType && event.targetType !== filter.targetType) return false;
  if (filter.outcome && event.outcome !== filter.outcome) return false;
  if (filter.since) {
    const since = Date.parse(filter.since);
    const at = Date.parse(event.at || "");
    if (Number.isFinite(since) && Number.isFinite(at) && at < since) return false;
  }
  if (filter.until) {
    const until = Date.parse(filter.until);
    const at = Date.parse(event.at || "");
    if (Number.isFinite(until) && Number.isFinite(at) && at > until) return false;
  }
  if (Array.isArray(filter.tags) && filter.tags.length > 0) {
    const eventTags = Array.isArray(event.tags) ? event.tags : [];
    if (!filter.tags.some((t) => eventTags.includes(t))) return false;
  }
  return true;
}

/**
 * Generate a report by filtering and (optionally) grouping events.
 *
 * @param {{scheduleId?: string, name?: string, type?: string, filter?: object, groupBy?: string, events: object[], periodStart?: string, periodEnd?: string}} request
 * @returns {Promise<Report>}
 */
export async function generateReport(request) {
  if (!request || typeof request !== "object") throw new Error("request required");
  if (!Array.isArray(request.events)) throw new Error("events must be an array");

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    let schedule = null;
    if (request.scheduleId) {
      schedule = data.schedules[request.scheduleId] || null;
      if (!schedule) throw new Error(`schedule ${request.scheduleId} not found`);
    }
    const name = request.name || schedule?.name || "ad-hoc";
    const type = request.type || schedule?.type || "all";
    const filter = request.filter || schedule?.filter || {};
    const groupBy = request.groupBy || schedule?.groupBy || "";

    const filtered = request.events.filter((e) => matchEvent({ ...filter, type }, e));
    const rows = [];
    if (groupBy) {
      /** @type {Record<string, number>} */
      const groups = {};
      for (const e of filtered) {
        const key = String(e[groupBy] ?? "unknown");
        groups[key] = (groups[key] || 0) + 1;
      }
      for (const [key, count] of Object.entries(groups)) {
        rows.push({ [groupBy]: key, count });
      }
      rows.sort((a, b) => b.count - a.count);
    } else {
      for (const e of filtered) {
        rows.push({
          at: e.at || "",
          actor: e.actor || "",
          type: e.type || "",
          targetType: e.targetType || "",
          target: e.target || "",
          outcome: e.outcome || "",
        });
      }
    }

    const summary = {
      total: filtered.length,
      byType: {},
      byOutcome: {},
    };
    for (const e of filtered) {
      summary.byType[e.type || "unknown"] = (summary.byType[e.type || "unknown"] || 0) + 1;
      if (e.outcome) summary.byOutcome[e.outcome] = (summary.byOutcome[e.outcome] || 0) + 1;
    }

    const id = newId("rpt");
    const ts = nowIso();
    const report = {
      id,
      scheduleId: schedule?.id || "",
      name,
      type,
      generatedAt: ts,
      periodStart: request.periodStart || filter.since || "",
      periodEnd: request.periodEnd || filter.until || "",
      summary,
      rows,
    };
    data.reports[id] = report;
    if (schedule) {
      schedule.lastRunAt = ts;
      data.schedules[schedule.id] = schedule;
    }
    await saveStore(data);
    return report;
  });
}

/**
 * List reports optionally filtered by schedule.
 *
 * @param {{scheduleId?: string, limit?: number}} [filter]
 * @returns {Promise<Report[]>}
 */
export async function listReports(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.reports || {});
  if (filter.scheduleId) {
    all = all.filter((r) => r.scheduleId === filter.scheduleId);
  }
  all.sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
  if (Number.isFinite(filter.limit) && filter.limit > 0) {
    all = all.slice(0, Math.floor(filter.limit));
  }
  return all;
}

/**
 * Fetch a single report by id.
 * @param {string} id
 */
export async function getReport(id) {
  if (!id) return null;
  const data = await loadStore();
  return data.reports[id] || null;
}

/**
 * Convert a report's rows into CSV text. Column order is stable based
 * on the first row's keys.
 *
 * @param {Report} report
 * @returns {string}
 */
export function exportCsv(report) {
  if (!report || typeof report !== "object") return "";
  const rows = Array.isArray(report.rows) ? report.rows : [];
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = columns.map(escape).join(",");
  const body = rows.map((r) => columns.map((c) => escape(r[c])).join(",")).join("\n");
  return `${header}\n${body}`;
}
