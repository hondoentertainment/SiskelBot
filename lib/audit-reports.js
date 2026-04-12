/**
 * Phase 65.4: Audit report generation — scheduled compliance reports.
 *
 * Builtin report templates:
 *   - soc2-access   : access/auth events grouped by user with allowed/denied counts
 *   - gdpr-dsr      : data subject requests / compliance actions
 *   - usage-summary : simple event counts + totals
 *
 * Reports are defined once (with id, template, filter) and either run on demand
 * via generateReport or scheduled via scheduleReport. Each run produces a report
 * record stored under the definition for later retrieval.
 *
 * Storage:
 *   data/audit-reports/defs/{defId}.json      — report definition
 *   data/audit-reports/runs/{runId}.json      — report run output
 *   data/audit-reports/_index.json            — registry of defs + runs
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const TEMPLATE_SOC2_ACCESS = "soc2-access";
export const TEMPLATE_GDPR_DSR = "gdpr-dsr";
export const TEMPLATE_USAGE_SUMMARY = "usage-summary";
const BUILTIN_TEMPLATES = new Set([TEMPLATE_SOC2_ACCESS, TEMPLATE_GDPR_DSR, TEMPLATE_USAGE_SUMMARY]);

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function defPath(id) {
  return join(getDataDir(), "audit-reports", "defs", `${sanitize(id)}.json`);
}

function runPath(id) {
  return join(getDataDir(), "audit-reports", "runs", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "audit-reports", "_index.json");
}

async function updateIndex(updater) {
  return withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { definitions: [], runs: [] });
    idx.definitions = Array.isArray(idx.definitions) ? idx.definitions : [];
    idx.runs = Array.isArray(idx.runs) ? idx.runs : [];
    await updater(idx);
    await writeJsonPath(indexPath(), idx);
  });
}

// ─── Definitions ───────────────────────────────────────────────────────────

/**
 * Define a new report (but do not run it yet).
 * template is one of the builtin templates or a custom string.
 * schedule is an opaque cron-like string; the scheduler is external.
 */
export async function defineReport({ name, template, filter, schedule, description, createdBy } = {}) {
  if (!name || typeof name !== "string") {
    throw new Error("name is required");
  }
  if (!template || typeof template !== "string") {
    throw new Error("template is required");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const record = {
    id,
    name,
    template,
    filter: filter && typeof filter === "object" ? filter : {},
    schedule: schedule || null,
    description: description || "",
    createdBy: createdBy || "",
    createdAt: now,
    updatedAt: now,
    runIds: [],
    lastRunAt: null,
    nextRunAt: null,
  };
  await writeJsonPath(defPath(id), record);
  await updateIndex((idx) => {
    idx.definitions.push({ id, name, template, schedule: record.schedule, createdAt: now });
  });
  return record;
}

export async function getReport(id) {
  if (!id) return null;
  const data = await readJsonPath(defPath(id), null);
  if (!data || !data.id || data._deleted) return null;
  return data;
}

export async function listReports(filter = {}) {
  const idx = await readJsonPath(indexPath(), { definitions: [] });
  const entries = Array.isArray(idx.definitions) ? idx.definitions : [];
  const records = [];
  for (const entry of entries) {
    const rec = await getReport(entry.id);
    if (!rec) continue;
    if (filter.template && rec.template !== filter.template) continue;
    if (filter.name && rec.name !== filter.name) continue;
    records.push(rec);
  }
  return records;
}

async function mutateDefinition(id, mutator) {
  return withPathLock(defPath(id), async () => {
    const rec = await readJsonPath(defPath(id), null);
    if (!rec || !rec.id || rec._deleted) {
      const err = new Error(`report ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const updated = await mutator(rec);
    if (updated) {
      updated.updatedAt = new Date().toISOString();
      await writeJsonPath(defPath(id), updated);
      return updated;
    }
    return rec;
  });
}

// ─── Schedule ──────────────────────────────────────────────────────────────

/**
 * Attach or update a schedule on a definition.
 */
export async function scheduleReport(id, { schedule, nextRunAt } = {}) {
  return mutateDefinition(id, (rec) => {
    rec.schedule = schedule || rec.schedule;
    if (nextRunAt != null) {
      const t = Date.parse(nextRunAt);
      rec.nextRunAt = Number.isFinite(t) ? new Date(t).toISOString() : rec.nextRunAt;
    }
    return rec;
  });
}

// ─── Generation ────────────────────────────────────────────────────────────

function filterEvents(events, filter, periodStart, periodEnd) {
  const s = periodStart ? Date.parse(periodStart) : null;
  const e = periodEnd ? Date.parse(periodEnd) : null;
  return events.filter((ev) => {
    if (!ev || typeof ev !== "object") return false;
    if (s != null && Number.isFinite(s)) {
      const at = Date.parse(ev.at || ev.timestamp);
      if (!Number.isFinite(at) || at < s) return false;
    }
    if (e != null && Number.isFinite(e)) {
      const at = Date.parse(ev.at || ev.timestamp);
      if (!Number.isFinite(at) || at >= e) return false;
    }
    for (const [k, v] of Object.entries(filter || {})) {
      if (k === "type" && v != null) {
        if (String(ev.type) !== String(v)) return false;
      } else if (k === "user" && v != null) {
        if (String(ev.user || ev.userId) !== String(v)) return false;
      } else if (v != null) {
        if (String(ev[k]) !== String(v)) return false;
      }
    }
    return true;
  });
}

function buildSoc2Access(events) {
  const byUser = {};
  let allowed = 0;
  let denied = 0;
  for (const ev of events) {
    const user = ev.user || ev.userId || "anonymous";
    byUser[user] = byUser[user] || { user, allowed: 0, denied: 0, firstAt: null, lastAt: null };
    const outcome = ev.outcome || ev.result || (ev.ok === false ? "denied" : "allowed");
    const at = ev.at || ev.timestamp || null;
    if (outcome === "allowed") {
      byUser[user].allowed += 1;
      allowed += 1;
    } else {
      byUser[user].denied += 1;
      denied += 1;
    }
    if (at) {
      if (!byUser[user].firstAt || at < byUser[user].firstAt) byUser[user].firstAt = at;
      if (!byUser[user].lastAt || at > byUser[user].lastAt) byUser[user].lastAt = at;
    }
  }
  return {
    kind: TEMPLATE_SOC2_ACCESS,
    totals: { events: events.length, allowed, denied },
    byUser: Object.values(byUser),
  };
}

function buildGdprDsr(events) {
  const requests = [];
  const byKind = {};
  for (const ev of events) {
    const kind = ev.requestKind || ev.subType || ev.type || "unknown";
    byKind[kind] = (byKind[kind] || 0) + 1;
    requests.push({
      id: ev.id || null,
      at: ev.at || ev.timestamp || null,
      kind,
      subject: ev.subject || ev.user || null,
      status: ev.status || ev.outcome || "unknown",
    });
  }
  return {
    kind: TEMPLATE_GDPR_DSR,
    totals: { requests: requests.length },
    byKind,
    requests,
  };
}

function buildUsageSummary(events) {
  const byType = {};
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const ev of events) {
    const t = ev.type || "event";
    byType[t] = (byType[t] || 0) + 1;
    if (Number.isFinite(Number(ev.costUsd))) totalCostUsd += Number(ev.costUsd);
    if (Number.isFinite(Number(ev.tokens))) totalTokens += Number(ev.tokens);
  }
  return {
    kind: TEMPLATE_USAGE_SUMMARY,
    totals: { events: events.length, totalCostUsd, totalTokens },
    byType,
  };
}

function buildSection(template, events) {
  if (template === TEMPLATE_SOC2_ACCESS) return buildSoc2Access(events);
  if (template === TEMPLATE_GDPR_DSR) return buildGdprDsr(events);
  if (template === TEMPLATE_USAGE_SUMMARY) return buildUsageSummary(events);
  // Custom templates default to a usage summary shape.
  return buildUsageSummary(events);
}

/**
 * Run a report definition against a list of events.
 *
 * Caller supplies events via `events` (an array) to keep this module decoupled
 * from the audit store. The report is persisted as a run record attached to
 * the definition.
 */
export async function generateReport(id, { events, periodStart, periodEnd, actor } = {}) {
  const def = await getReport(id);
  if (!def) {
    const err = new Error(`report ${id} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const evs = Array.isArray(events) ? events : [];
  const filtered = filterEvents(evs, def.filter, periodStart, periodEnd);
  const output = buildSection(def.template, filtered);
  const runId = randomUUID();
  const now = new Date().toISOString();
  const run = {
    id: runId,
    definitionId: def.id,
    definitionName: def.name,
    template: def.template,
    periodStart: periodStart || null,
    periodEnd: periodEnd || null,
    generatedAt: now,
    generatedBy: actor || "system",
    eventCount: filtered.length,
    output,
  };
  await writeJsonPath(runPath(runId), run);
  await updateIndex((idx) => {
    idx.runs.push({ id: runId, definitionId: def.id, generatedAt: now });
  });
  await mutateDefinition(def.id, (rec) => {
    rec.runIds.push(runId);
    rec.lastRunAt = now;
    return rec;
  });
  return run;
}

export async function getRun(runId) {
  if (!runId) return null;
  const data = await readJsonPath(runPath(runId), null);
  if (!data || !data.id || data._deleted) return null;
  return data;
}

export async function listRuns({ definitionId } = {}) {
  const idx = await readJsonPath(indexPath(), { runs: [] });
  const entries = Array.isArray(idx.runs) ? idx.runs : [];
  const records = [];
  for (const entry of entries) {
    if (definitionId && entry.definitionId !== definitionId) continue;
    const run = await getRun(entry.id);
    if (run) records.push(run);
  }
  return records;
}

export const _internals = {
  defPath,
  runPath,
  indexPath,
  filterEvents,
  buildSection,
  BUILTIN_TEMPLATES,
};
