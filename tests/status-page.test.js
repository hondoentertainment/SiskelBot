/**
 * Phase 60.5: status-page tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-statuspage-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  getStatusPage,
  postIncident,
  updateIncident,
  resolveIncident,
  setComponentStatus,
  listIncidents,
  computeUptime,
} = await import("../lib/status-page.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("setComponentStatus creates and updates components", async () => {
  const c = await setComponentStatus("api", "operational", "all systems nominal");
  assert.equal(c.id, "api");
  assert.equal(c.status, "operational");
  const c2 = await setComponentStatus("api", "degraded", "slow responses");
  assert.equal(c2.status, "degraded");
  assert.equal(c2.statusMessage, "slow responses");
});

test("setComponentStatus rejects invalid status", async () => {
  await assert.rejects(() => setComponentStatus("api", "invalid-status"));
  await assert.rejects(() => setComponentStatus("", "operational"));
});

test("postIncident creates an incident with initial update", async () => {
  const inc = await postIncident({
    title: "API slow",
    description: "We are investigating",
    impact: "major",
    components: ["api"],
  });
  assert.ok(inc.id);
  assert.equal(inc.title, "API slow");
  assert.equal(inc.impact, "major");
  assert.equal(inc.updates.length, 1);
  assert.equal(inc.status, "investigating");
});

test("postIncident rejects invalid impact and status", async () => {
  await assert.rejects(() => postIncident({ title: "x", impact: "bogus" }));
  await assert.rejects(() => postIncident({ title: "x", status: "unknown" }));
  await assert.rejects(() => postIncident({}));
});

test("updateIncident appends a new update", async () => {
  const inc = await postIncident({ title: "Bug", impact: "minor" });
  const updated = await updateIncident(inc.id, { status: "identified", message: "root cause found" });
  assert.equal(updated.status, "identified");
  assert.equal(updated.updates.length, 2);
});

test("updateIncident rejects invalid input", async () => {
  const inc = await postIncident({ title: "X", impact: "minor" });
  await assert.rejects(() => updateIncident(inc.id, { status: "nope" }));
  await assert.rejects(() => updateIncident("missing", { message: "nope" }));
});

test("resolveIncident marks incident as resolved", async () => {
  const inc = await postIncident({ title: "Outage", impact: "critical" });
  const resolved = await resolveIncident(inc.id, "hotfix deployed");
  assert.equal(resolved.status, "resolved");
  assert.ok(resolved.resolvedAt);
  assert.ok(resolved.updates.some((u) => u.message === "hotfix deployed"));
});

test("listIncidents filters by status", async () => {
  const active = await postIncident({ title: "Active one", impact: "minor" });
  const done = await postIncident({ title: "Done one", impact: "minor" });
  await resolveIncident(done.id);
  const activeList = await listIncidents({ status: "investigating" });
  assert.ok(activeList.some((i) => i.id === active.id));
  assert.ok(!activeList.some((i) => i.id === done.id));
  const resolvedList = await listIncidents({ status: "resolved" });
  assert.ok(resolvedList.some((i) => i.id === done.id));
});

test("listIncidents filters by componentId", async () => {
  const inc = await postIncident({
    title: "Web bug",
    impact: "minor",
    components: ["web"],
  });
  const byWeb = await listIncidents({ componentId: "web" });
  assert.ok(byWeb.some((i) => i.id === inc.id));
  const byOther = await listIncidents({ componentId: "db" });
  assert.ok(!byOther.some((i) => i.id === inc.id));
});

test("computeUptime returns 100% when no downtime", () => {
  const result = computeUptime("api", [], { days: 30 });
  assert.equal(result.uptimePct, 100);
  assert.equal(result.downtimeMs, 0);
});

test("computeUptime accounts for downtime transitions", () => {
  const now = Date.parse("2024-06-01T00:00:00Z");
  const oneDay = 24 * 60 * 60 * 1000;
  const history = [
    { componentId: "api", from: "operational", to: "major-outage", at: new Date(now - oneDay * 2).toISOString() },
    { componentId: "api", from: "major-outage", to: "operational", at: new Date(now - oneDay * 2 + oneDay).toISOString() },
  ];
  const result = computeUptime("api", history, { days: 30, now });
  assert.ok(result.downtimeMs >= oneDay - 1000);
  assert.ok(result.uptimePct < 100);
  assert.ok(result.uptimePct > 90);
});

test("getStatusPage returns components, incidents, and overall status", async () => {
  await setComponentStatus("api", "operational");
  await setComponentStatus("db", "degraded");
  const inc = await postIncident({ title: "DB latency", impact: "minor", components: ["db"] });
  const page = await getStatusPage();
  assert.ok(Array.isArray(page.components));
  assert.ok(page.components.some((c) => c.id === "api"));
  assert.ok(page.components.some((c) => c.id === "db"));
  assert.ok(page.activeIncidents.some((i) => i.id === inc.id));
  assert.ok(["operational", "degraded", "partial-outage", "major-outage", "maintenance"].includes(page.overall));
});

test("getStatusPage elevates overall to major-outage on critical incident", async () => {
  await postIncident({ title: "Total outage", impact: "critical" });
  const page = await getStatusPage();
  assert.equal(page.overall, "major-outage");
});
