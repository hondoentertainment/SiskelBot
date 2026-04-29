/**
 * Phase 60.5: Public status page.
 *
 * Customer-facing status + 90-day incident history. Uses the in-memory SLO
 * tracker (lib/slo-tracker.js) as the source of truth for current component
 * health; incidents are persisted separately so status history survives
 * restarts.
 *
 * Component state is derived by mapping each configured SLO to a
 * green/yellow/red state based on the tracker's burn-rate classification:
 *   healthy -> green
 *   warning -> yellow
 *   critical -> red
 *
 * Storage layout (via json-path-store):
 *   data/status-page/incidents.json  — incident log
 *   data/status-page/components.json — optional manual overrides (e.g.
 *     for components that the SLO tracker does not cover)
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { globalSLOTracker } from "./slo-tracker.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export const STATUS_GREEN = "green";
export const STATUS_YELLOW = "yellow";
export const STATUS_RED = "red";
export const STATUS_UNKNOWN = "unknown";

export const INCIDENT_STATUS = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
];

export const INCIDENT_IMPACT = [
  "none",
  "minor",
  "major",
  "critical",
];

const HISTORY_DAYS = 90;
const MAX_INCIDENTS = Number(process.env.STATUS_PAGE_MAX_INCIDENTS) || 1000;

// ─── Path helpers ──────────────────────────────────────────────────────────

function incidentsPath() {
  return join(getDataDir(), "status-page", "incidents.json");
}

function componentsPath() {
  return join(getDataDir(), "status-page", "components.json");
}

// ─── Component state mapping ───────────────────────────────────────────────

function trackerStatusToState(trackerStatus) {
  if (trackerStatus === "healthy") return STATUS_GREEN;
  if (trackerStatus === "warning") return STATUS_YELLOW;
  if (trackerStatus === "critical") return STATUS_RED;
  return STATUS_UNKNOWN;
}

/**
 * Render each configured SLO as a component row. The SLO name becomes the
 * component name. Manual overrides from `components.json` replace the
 * derived state when present.
 */
async function loadComponents() {
  const slos = globalSLOTracker.getAllSLOs();
  const overrides = await readJsonPath(componentsPath(), { components: [] });
  const overrideMap = new Map();
  if (overrides && Array.isArray(overrides.components)) {
    for (const c of overrides.components) {
      if (c && c.name) overrideMap.set(c.name, c);
    }
  }

  const derived = slos.map((s) => {
    const state = trackerStatusToState(s.status);
    const ov = overrideMap.get(s.name);
    return {
      name: s.name,
      description: s.description || "",
      state: ov?.state || state,
      derivedState: state,
      target: s.target,
      current: s.current,
      metric: s.metric,
      burnRate: s.budget?.burnRate ?? 0,
      remaining: s.budget?.remainingFraction ?? 1,
      overridden: Boolean(ov?.state),
      note: ov?.note || null,
    };
  });

  // Include override-only components that aren't backed by an SLO.
  for (const [name, ov] of overrideMap) {
    if (!derived.some((c) => c.name === name)) {
      derived.push({
        name,
        description: ov.description || "",
        state: ov.state || STATUS_UNKNOWN,
        derivedState: null,
        target: null,
        current: null,
        metric: null,
        burnRate: null,
        remaining: null,
        overridden: true,
        note: ov.note || null,
      });
    }
  }

  return derived;
}

// ─── Public status ─────────────────────────────────────────────────────────

export async function getStatus(options = {}) {
  const now = options.now || new Date();
  const components = await loadComponents();
  const activeIncidents = await listIncidents({ resolved: false });

  let overall = STATUS_GREEN;
  for (const c of components) {
    if (c.state === STATUS_RED) { overall = STATUS_RED; break; }
    if (c.state === STATUS_YELLOW) overall = STATUS_YELLOW;
  }
  if (activeIncidents.some((i) => i.impact === "critical")) overall = STATUS_RED;
  else if (overall !== STATUS_RED && activeIncidents.some((i) => i.impact === "major")) {
    overall = overall === STATUS_GREEN ? STATUS_YELLOW : overall;
  }

  const history = await buildHistoryStrip(HISTORY_DAYS, now);

  return {
    generatedAt: now.toISOString(),
    overall,
    components,
    activeIncidents,
    history,
  };
}

// ─── Incidents ─────────────────────────────────────────────────────────────

function validateIncident(incident) {
  if (!incident || typeof incident !== "object") throw new Error("incident must be an object");
  if (!incident.title || typeof incident.title !== "string") {
    throw new Error("incident.title is required");
  }
  if (incident.status && !INCIDENT_STATUS.includes(incident.status)) {
    throw new Error(`incident.status must be one of: ${INCIDENT_STATUS.join(", ")}`);
  }
  if (incident.impact && !INCIDENT_IMPACT.includes(incident.impact)) {
    throw new Error(`incident.impact must be one of: ${INCIDENT_IMPACT.join(", ")}`);
  }
}

export async function recordIncident(incident) {
  validateIncident(incident);
  return withPathLock(incidentsPath(), async () => {
    const data = await readJsonPath(incidentsPath(), { incidents: [] });
    const list = Array.isArray(data.incidents) ? data.incidents : [];
    const now = new Date().toISOString();
    const record = {
      id: randomUUID(),
      title: String(incident.title),
      status: incident.status || "investigating",
      impact: incident.impact || "minor",
      components: Array.isArray(incident.components) ? incident.components.map(String) : [],
      startedAt: incident.startedAt || now,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      updates: [
        {
          at: now,
          status: incident.status || "investigating",
          message: incident.message || incident.title,
        },
      ],
    };
    list.push(record);
    if (list.length > MAX_INCIDENTS) list.splice(0, list.length - MAX_INCIDENTS);
    await writeJsonPath(incidentsPath(), { incidents: list });
    return record;
  });
}

export async function updateIncident(id, updates = {}) {
  if (!id) throw new Error("incident id is required");
  return withPathLock(incidentsPath(), async () => {
    const data = await readJsonPath(incidentsPath(), { incidents: [] });
    const list = Array.isArray(data.incidents) ? data.incidents : [];
    const idx = list.findIndex((i) => i.id === id);
    if (idx === -1) {
      const err = new Error(`incident ${id} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const incident = list[idx];
    const now = new Date().toISOString();
    if (updates.status) {
      if (!INCIDENT_STATUS.includes(updates.status)) {
        throw new Error(`status must be one of: ${INCIDENT_STATUS.join(", ")}`);
      }
      incident.status = updates.status;
      if (updates.status === "resolved" && !incident.resolvedAt) {
        incident.resolvedAt = now;
      }
    }
    if (updates.impact) {
      if (!INCIDENT_IMPACT.includes(updates.impact)) {
        throw new Error(`impact must be one of: ${INCIDENT_IMPACT.join(", ")}`);
      }
      incident.impact = updates.impact;
    }
    if (Array.isArray(updates.components)) {
      incident.components = updates.components.map(String);
    }
    if (updates.title) incident.title = String(updates.title);
    incident.updates.push({
      at: now,
      status: updates.status || incident.status,
      message: updates.message || updates.note || "",
    });
    incident.updatedAt = now;
    list[idx] = incident;
    await writeJsonPath(incidentsPath(), { incidents: list });
    return incident;
  });
}

export async function listIncidents(filter = {}) {
  const data = await readJsonPath(incidentsPath(), { incidents: [] });
  const list = Array.isArray(data.incidents) ? data.incidents : [];
  let rows = list.slice();
  if (filter.resolved === true) {
    rows = rows.filter((i) => i.status === "resolved");
  } else if (filter.resolved === false) {
    rows = rows.filter((i) => i.status !== "resolved");
  }
  if (filter.component) {
    rows = rows.filter((i) => Array.isArray(i.components) && i.components.includes(filter.component));
  }
  if (Number.isFinite(Number(filter.sinceMs))) {
    const cutoff = Date.now() - Number(filter.sinceMs);
    rows = rows.filter((i) => Date.parse(i.startedAt) >= cutoff);
  }
  // newest first
  rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return rows;
}

export async function getIncident(id) {
  const data = await readJsonPath(incidentsPath(), { incidents: [] });
  const list = Array.isArray(data.incidents) ? data.incidents : [];
  return list.find((i) => i.id === id) || null;
}

// ─── Component overrides ───────────────────────────────────────────────────

export async function setComponentOverride(component) {
  if (!component || !component.name) throw new Error("component.name is required");
  return withPathLock(componentsPath(), async () => {
    const data = await readJsonPath(componentsPath(), { components: [] });
    const list = Array.isArray(data.components) ? data.components : [];
    const filtered = list.filter((c) => c.name !== component.name);
    filtered.push({
      name: String(component.name),
      description: typeof component.description === "string" ? component.description : "",
      state: component.state || STATUS_UNKNOWN,
      note: component.note || null,
      updatedAt: new Date().toISOString(),
    });
    await writeJsonPath(componentsPath(), { components: filtered });
    return filtered;
  });
}

export async function clearComponentOverride(name) {
  return withPathLock(componentsPath(), async () => {
    const data = await readJsonPath(componentsPath(), { components: [] });
    const list = Array.isArray(data.components) ? data.components : [];
    const filtered = list.filter((c) => c.name !== name);
    await writeJsonPath(componentsPath(), { components: filtered });
    return filtered;
  });
}

// ─── 90-day history strip ─────────────────────────────────────────────────

/**
 * Compute a 90-day history strip — one bucket per day. Each bucket reports
 * the worst status encountered that day based on incident impact.
 */
export async function buildHistoryStrip(days = HISTORY_DAYS, now = new Date()) {
  const end = now instanceof Date ? now.getTime() : Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const start = end - days * oneDayMs;
  const incidents = await listIncidents({ sinceMs: days * oneDayMs });

  const buckets = [];
  for (let i = 0; i < days; i += 1) {
    const bucketStart = start + i * oneDayMs;
    const bucketEnd = bucketStart + oneDayMs;
    const overlapping = incidents.filter((inc) => {
      const s = Date.parse(inc.startedAt);
      const e = inc.resolvedAt ? Date.parse(inc.resolvedAt) : end;
      return s < bucketEnd && e >= bucketStart;
    });
    let worst = STATUS_GREEN;
    for (const inc of overlapping) {
      if (inc.impact === "critical") { worst = STATUS_RED; break; }
      if (inc.impact === "major") worst = STATUS_RED;
      else if (inc.impact === "minor" && worst !== STATUS_RED) worst = STATUS_YELLOW;
    }
    buckets.push({
      date: new Date(bucketStart).toISOString().slice(0, 10),
      state: worst,
      incidentCount: overlapping.length,
    });
  }
  return buckets;
}

export const _internals = {
  incidentsPath,
  componentsPath,
  trackerStatusToState,
};

// ─── Alertmanager → external status page bridge ────────────────────────────
//
// Translates Alertmanager webhook payloads into status page incidents on
// Statuspage.io (Atlassian) or cstate (self-hosted). Configure via env:
//   STATUS_PAGE_ENABLED=1
//   STATUS_PAGE_PROVIDER=statuspage      # or "cstate"
//   STATUSPAGE_API_KEY=...
//   STATUSPAGE_PAGE_ID=...
//   STATUS_PAGE_COMPONENT_MAP={"SiskelBotProbeDown":"abc123",...}
//   ALERTMANAGER_WEBHOOK_SECRET=...      # used by routes/alertmanager-webhook.js

const ALERT_TO_INCIDENT_STATUS = {
  firing: "investigating",
  resolved: "resolved",
};

const SEVERITY_TO_IMPACT = {
  critical: "major",
  warning: "minor",
  info: "none",
};

/**
 * Process an Alertmanager webhook payload and post matching incidents to the
 * configured external status page provider.
 * Returns { posted: number, skipped: number, errors: Array }.
 */
export async function processAlertmanagerPayload(payload) {
  if (process.env.STATUS_PAGE_ENABLED !== "1") {
    return { posted: 0, skipped: payload?.alerts?.length || 0, errors: [] };
  }

  const provider = process.env.STATUS_PAGE_PROVIDER || "statuspage";
  const componentMap = parseComponentMap();
  const results = { posted: 0, skipped: 0, errors: [] };

  for (const alert of payload?.alerts || []) {
    const alertname = alert.labels?.alertname;
    const componentId = componentMap[alertname];

    // Only post incidents for alerts mapped to status page components
    if (!componentId) {
      results.skipped += 1;
      continue;
    }

    try {
      if (provider === "statuspage") {
        await postStatuspageIncident(alert, componentId);
      } else if (provider === "cstate") {
        await writeCstateIncident(alert, componentId);
      } else {
        throw new Error(`Unknown provider: ${provider}`);
      }
      results.posted += 1;
    } catch (e) {
      results.errors.push({ alertname, error: e.message });
    }
  }

  return results;
}

async function postStatuspageIncident(alert, componentId) {
  const apiKey = process.env.STATUSPAGE_API_KEY;
  const pageId = process.env.STATUSPAGE_PAGE_ID;
  if (!apiKey || !pageId) throw new Error("STATUSPAGE_API_KEY/PAGE_ID required");

  const status = ALERT_TO_INCIDENT_STATUS[alert.status] || "investigating";
  const impact = SEVERITY_TO_IMPACT[alert.labels?.severity] || "minor";

  const body = {
    incident: {
      name: alert.annotations?.summary || alert.labels?.alertname,
      status,
      impact_override: impact,
      body: alert.annotations?.description || "",
      components: { [componentId]: status === "resolved" ? "operational" : "major_outage" },
      component_ids: [componentId],
    },
  };

  const url = `https://api.statuspage.io/v1/pages/${pageId}/incidents`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `OAuth ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Statuspage API ${resp.status}: ${text}`);
  }
}

async function writeCstateIncident(_alert, _componentId) {
  // cstate uses YAML frontmatter files in content/issues/. Implementing a
  // filesystem write is deferred; operators can run a small sidecar that
  // tails our /api/v1/status/incidents endpoint instead.
  throw new Error("cstate provider: implement via filesystem write to STATUS_PAGE_CSTATE_DIR (TODO)");
}

function parseComponentMap() {
  const raw = process.env.STATUS_PAGE_COMPONENT_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export const _alertmanagerInternals = {
  parseComponentMap,
  ALERT_TO_INCIDENT_STATUS,
  SEVERITY_TO_IMPACT,
};
