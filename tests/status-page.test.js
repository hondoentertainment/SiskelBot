/**
 * Phase 60.5: Status page tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-status-page-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  getStatus,
  listIncidents,
  recordIncident,
  updateIncident,
  getIncident,
  setComponentOverride,
  clearComponentOverride,
  buildHistoryStrip,
  STATUS_GREEN,
  STATUS_YELLOW,
  STATUS_RED,
  INCIDENT_STATUS,
  INCIDENT_IMPACT,
} = await import("../lib/status-page.js");

const { globalSLOTracker } = await import("../lib/slo-tracker.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ─── Enums ────────────────────────────────────────────────────────────────

test("INCIDENT_STATUS and INCIDENT_IMPACT expose the expected values", () => {
  assert.ok(INCIDENT_STATUS.includes("investigating"));
  assert.ok(INCIDENT_STATUS.includes("resolved"));
  assert.ok(INCIDENT_IMPACT.includes("none"));
  assert.ok(INCIDENT_IMPACT.includes("critical"));
});

// ─── Incidents CRUD ───────────────────────────────────────────────────────

test("recordIncident persists a new incident with defaults", async () => {
  const inc = await recordIncident({ title: "DB slowdown" });
  assert.ok(inc.id);
  assert.equal(inc.title, "DB slowdown");
  assert.equal(inc.status, "investigating");
  assert.equal(inc.impact, "minor");
  assert.ok(inc.updates.length === 1);
});

test("recordIncident rejects invalid status", async () => {
  await assert.rejects(() => recordIncident({ title: "bad", status: "bogus" }));
});

test("updateIncident appends to updates log and sets resolvedAt on resolve", async () => {
  const inc = await recordIncident({ title: "Edge failure" });
  const updated = await updateIncident(inc.id, {
    status: "resolved",
    message: "fixed",
  });
  assert.equal(updated.status, "resolved");
  assert.ok(updated.resolvedAt);
  assert.ok(updated.updates.length === 2);
});

test("updateIncident 404s for unknown id", async () => {
  await assert.rejects(() => updateIncident("nope", { status: "resolved" }));
});

test("listIncidents filters by resolved flag and component", async () => {
  const a = await recordIncident({ title: "A", components: ["api"], impact: "major" });
  await recordIncident({ title: "B", components: ["web"] });
  await updateIncident(a.id, { status: "resolved", message: "fixed" });
  const open = await listIncidents({ resolved: false });
  const closed = await listIncidents({ resolved: true });
  const apiOnly = await listIncidents({ component: "api" });
  assert.ok(open.every((i) => i.status !== "resolved"));
  assert.ok(closed.every((i) => i.status === "resolved"));
  assert.ok(apiOnly.every((i) => i.components.includes("api")));
});

test("getIncident returns the incident by id", async () => {
  const a = await recordIncident({ title: "Fetch me" });
  const loaded = await getIncident(a.id);
  assert.equal(loaded.title, "Fetch me");
  assert.equal(await getIncident("nonexistent"), null);
});

// ─── Status derivation ────────────────────────────────────────────────────

test("getStatus returns green when SLOs are healthy and no incidents", async () => {
  globalSLOTracker.reset();
  // Seed a bunch of successes to keep burn rate low.
  for (let i = 0; i < 200; i += 1) {
    globalSLOTracker.recordEvent("success_rate", 1);
  }
  // Clean persisted incidents fresh.
  rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "siskel-status-page-2-"));
  const status = await getStatus();
  assert.equal(status.overall, STATUS_GREEN);
  assert.ok(Array.isArray(status.components));
  assert.ok(Array.isArray(status.history));
  assert.equal(status.history.length, 90);
});

test("getStatus reports red when a critical incident is active", async () => {
  await recordIncident({ title: "Critical outage", impact: "critical" });
  const status = await getStatus();
  assert.equal(status.overall, STATUS_RED);
});

// ─── Component overrides ──────────────────────────────────────────────────

test("setComponentOverride + clearComponentOverride affect getStatus", async () => {
  process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "siskel-status-page-override-"));
  await setComponentOverride({
    name: "availability",
    state: STATUS_YELLOW,
    note: "scheduled maintenance",
  });
  const before = await getStatus();
  const avail = before.components.find((c) => c.name === "availability");
  assert.ok(avail);
  assert.equal(avail.state, STATUS_YELLOW);
  assert.ok(avail.overridden);
  await clearComponentOverride("availability");
  const after = await getStatus();
  const availAfter = after.components.find((c) => c.name === "availability");
  assert.ok(!availAfter.overridden);
});

// ─── 90-day history strip ────────────────────────────────────────────────

test("buildHistoryStrip returns 90 daily buckets", async () => {
  process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "siskel-status-page-hist-"));
  const buckets = await buildHistoryStrip();
  assert.equal(buckets.length, 90);
  for (const b of buckets) {
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(b.date));
    assert.ok([STATUS_GREEN, STATUS_YELLOW, STATUS_RED].includes(b.state));
  }
});

test("buildHistoryStrip marks a day red when a critical incident ran that day", async () => {
  process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "siskel-status-page-hist-red-"));
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await recordIncident({
    title: "Yesterday's pain",
    impact: "critical",
    startedAt: yesterday.toISOString(),
  });
  const buckets = await buildHistoryStrip(90, now);
  const redDays = buckets.filter((b) => b.state === STATUS_RED);
  assert.ok(redDays.length >= 1);
});

// ─── Alertmanager → external status page bridge ───────────────────────────

const { processAlertmanagerPayload } = await import("../lib/status-page.js");

const STATUS_PAGE_ENV_KEYS = [
  "STATUS_PAGE_ENABLED",
  "STATUS_PAGE_PROVIDER",
  "STATUSPAGE_API_KEY",
  "STATUSPAGE_PAGE_ID",
  "STATUS_PAGE_COMPONENT_MAP",
];

function snapshotStatusPageEnv() {
  const snap = {};
  for (const k of STATUS_PAGE_ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreStatusPageEnv(snap) {
  for (const k of STATUS_PAGE_ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function makeAlert({
  alertname = "SiskelBotProbeDown",
  status = "firing",
  severity = "critical",
  summary = "Probe failing",
  description = "the probe is down",
} = {}) {
  return {
    status,
    labels: { alertname, severity },
    annotations: { summary, description },
  };
}

test("processAlertmanagerPayload: disabled (env not set) returns posted=0 and skips all alerts without calling fetch", async () => {
  const snap = snapshotStatusPageEnv();
  const origFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => { fetchCalls += 1; return Promise.resolve({ ok: true, text: async () => "" }); };
  try {
    delete process.env.STATUS_PAGE_ENABLED;
    const result = await processAlertmanagerPayload({ alerts: [makeAlert(), makeAlert()] });
    assert.equal(result.posted, 0);
    assert.equal(result.skipped, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = origFetch;
    restoreStatusPageEnv(snap);
  }
});

test("processAlertmanagerPayload: alert with mapped component posts to Statuspage with correct URL and body", async () => {
  const snap = snapshotStatusPageEnv();
  const origFetch = global.fetch;
  const calls = [];
  global.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({ ok: true, text: async () => "" });
  };
  try {
    process.env.STATUS_PAGE_ENABLED = "1";
    process.env.STATUS_PAGE_PROVIDER = "statuspage";
    process.env.STATUSPAGE_API_KEY = "test-key";
    process.env.STATUSPAGE_PAGE_ID = "page123";
    process.env.STATUS_PAGE_COMPONENT_MAP = JSON.stringify({ SiskelBotProbeDown: "comp-abc" });

    const result = await processAlertmanagerPayload({ alerts: [makeAlert()] });

    assert.equal(result.posted, 1);
    assert.equal(result.skipped, 0);
    assert.deepEqual(result.errors, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.statuspage.io/v1/pages/page123/incidents");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers["Authorization"], "OAuth test-key");
    assert.equal(calls[0].opts.headers["Content-Type"], "application/json");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.incident.name, "Probe failing");
    assert.equal(body.incident.status, "investigating");
    assert.equal(body.incident.impact_override, "major");
    assert.deepEqual(body.incident.component_ids, ["comp-abc"]);
    assert.equal(body.incident.components["comp-abc"], "major_outage");
  } finally {
    global.fetch = origFetch;
    restoreStatusPageEnv(snap);
  }
});

test("processAlertmanagerPayload: alert without mapped component is skipped (no fetch call)", async () => {
  const snap = snapshotStatusPageEnv();
  const origFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => { fetchCalls += 1; return Promise.resolve({ ok: true, text: async () => "" }); };
  try {
    process.env.STATUS_PAGE_ENABLED = "1";
    process.env.STATUS_PAGE_PROVIDER = "statuspage";
    process.env.STATUSPAGE_API_KEY = "test-key";
    process.env.STATUSPAGE_PAGE_ID = "page123";
    process.env.STATUS_PAGE_COMPONENT_MAP = JSON.stringify({ SiskelBotProbeDown: "comp-abc" });

    const result = await processAlertmanagerPayload({
      alerts: [makeAlert({ alertname: "UnmappedAlert" })],
    });

    assert.equal(result.posted, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = origFetch;
    restoreStatusPageEnv(snap);
  }
});

test("processAlertmanagerPayload: fetch failure is recorded in errors[] but does not throw", async () => {
  const snap = snapshotStatusPageEnv();
  const origFetch = global.fetch;
  global.fetch = () => Promise.resolve({ ok: false, status: 500, text: async () => "internal error" });
  try {
    process.env.STATUS_PAGE_ENABLED = "1";
    process.env.STATUS_PAGE_PROVIDER = "statuspage";
    process.env.STATUSPAGE_API_KEY = "test-key";
    process.env.STATUSPAGE_PAGE_ID = "page123";
    process.env.STATUS_PAGE_COMPONENT_MAP = JSON.stringify({ SiskelBotProbeDown: "comp-abc" });

    const result = await processAlertmanagerPayload({ alerts: [makeAlert()] });

    assert.equal(result.posted, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].alertname, "SiskelBotProbeDown");
    assert.match(result.errors[0].error, /Statuspage API 500/);
  } finally {
    global.fetch = origFetch;
    restoreStatusPageEnv(snap);
  }
});

test("processAlertmanagerPayload: malformed STATUS_PAGE_COMPONENT_MAP yields empty map and all alerts skipped", async () => {
  const snap = snapshotStatusPageEnv();
  const origFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = () => { fetchCalls += 1; return Promise.resolve({ ok: true, text: async () => "" }); };
  try {
    process.env.STATUS_PAGE_ENABLED = "1";
    process.env.STATUS_PAGE_PROVIDER = "statuspage";
    process.env.STATUSPAGE_API_KEY = "test-key";
    process.env.STATUSPAGE_PAGE_ID = "page123";
    process.env.STATUS_PAGE_COMPONENT_MAP = "{not valid json";

    const result = await processAlertmanagerPayload({
      alerts: [makeAlert(), makeAlert({ alertname: "SiskelBotHighErrorRate", severity: "warning" })],
    });

    assert.equal(result.posted, 0);
    assert.equal(result.skipped, 2);
    assert.deepEqual(result.errors, []);
    assert.equal(fetchCalls, 0);
  } finally {
    global.fetch = origFetch;
    restoreStatusPageEnv(snap);
  }
});

test("processAlertmanagerPayload: resolved alert sets component status to operational and impact-aware status", async () => {
  const snap = snapshotStatusPageEnv();
  const origFetch = global.fetch;
  const calls = [];
  global.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve({ ok: true, text: async () => "" });
  };
  try {
    process.env.STATUS_PAGE_ENABLED = "1";
    process.env.STATUS_PAGE_PROVIDER = "statuspage";
    process.env.STATUSPAGE_API_KEY = "test-key";
    process.env.STATUSPAGE_PAGE_ID = "page123";
    process.env.STATUS_PAGE_COMPONENT_MAP = JSON.stringify({ SiskelBotProbeDown: "comp-abc" });

    const result = await processAlertmanagerPayload({
      alerts: [makeAlert({ status: "resolved" })],
    });

    assert.equal(result.posted, 1);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.incident.status, "resolved");
    assert.equal(body.incident.components["comp-abc"], "operational");
  } finally {
    global.fetch = origFetch;
    restoreStatusPageEnv(snap);
  }
});
