/**
 * Phase 65.4: Audit reports tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-audit-reports-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  scheduleReport,
  generateReport,
  listReports,
  getReport,
  exportCsv,
  cancelSchedule,
  listSchedules,
  matchEvent,
} = await import("../lib/audit-reports.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

const fakeEvents = [
  { at: "2026-04-01T10:00:00Z", actor: "alice", type: "access", targetType: "document", target: "d1", outcome: "allow" },
  { at: "2026-04-01T11:00:00Z", actor: "alice", type: "access", targetType: "document", target: "d2", outcome: "deny" },
  { at: "2026-04-02T12:00:00Z", actor: "bob", type: "admin", targetType: "user", target: "charlie", outcome: "allow" },
  { at: "2026-04-03T09:00:00Z", actor: "carol", type: "policy", targetType: "policy", target: "pol1", outcome: "allow" },
];

test("scheduleReport creates a schedule with validated cadence", async () => {
  const s = await scheduleReport({
    name: "daily-access-report",
    type: "access",
    cadence: "daily",
    filter: {},
    recipients: ["[email protected]"],
  });
  assert.ok(s.id);
  assert.equal(s.cadence, "daily");
  assert.equal(s.enabled, true);
  assert.deepEqual(s.recipients, ["[email protected]"]);
});

test("scheduleReport rejects invalid cadences and types", async () => {
  await assert.rejects(() => scheduleReport({ name: "x", cadence: "yearly" }));
  await assert.rejects(() => scheduleReport({ name: "x", type: "bogus" }));
  await assert.rejects(() => scheduleReport(null));
  await assert.rejects(() => scheduleReport({ cadence: "daily" }));
});

test("matchEvent filters by type, actor, outcome, since, until", () => {
  const e = fakeEvents[0];
  assert.equal(matchEvent({ type: "access" }, e), true);
  assert.equal(matchEvent({ type: "admin" }, e), false);
  assert.equal(matchEvent({ actor: "alice" }, e), true);
  assert.equal(matchEvent({ actor: "bob" }, e), false);
  assert.equal(matchEvent({ outcome: "allow" }, e), true);
  assert.equal(matchEvent({ since: "2026-04-01" }, e), true);
  assert.equal(matchEvent({ until: "2026-03-01" }, e), false);
  assert.equal(matchEvent({ type: "all" }, e), true);
});

test("generateReport materializes filtered rows without grouping", async () => {
  const report = await generateReport({
    name: "ad-hoc",
    type: "access",
    filter: {},
    events: fakeEvents,
  });
  assert.ok(report.id);
  assert.equal(report.rows.length, 2);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.byType.access, 2);
});

test("generateReport groups by actor when requested", async () => {
  const report = await generateReport({
    name: "by-actor",
    type: "all",
    filter: {},
    groupBy: "actor",
    events: fakeEvents,
  });
  assert.ok(report.rows.length >= 1);
  const aliceRow = report.rows.find((r) => r.actor === "alice");
  assert.ok(aliceRow);
  assert.equal(aliceRow.count, 2);
  // Rows should be sorted desc by count
  assert.ok(report.rows[0].count >= report.rows[report.rows.length - 1].count);
});

test("generateReport uses a schedule when scheduleId is passed", async () => {
  const sched = await scheduleReport({
    name: "admin-events",
    type: "admin",
    cadence: "weekly",
    filter: {},
  });
  const report = await generateReport({ scheduleId: sched.id, events: fakeEvents });
  assert.equal(report.type, "admin");
  assert.equal(report.scheduleId, sched.id);
  assert.equal(report.summary.total, 1);
});

test("generateReport throws on missing schedule id", async () => {
  await assert.rejects(() => generateReport({ scheduleId: "missing", events: [] }));
  await assert.rejects(() => generateReport({ events: "not-array" }));
});

test("listReports filters and sorts by generatedAt desc", async () => {
  await generateReport({ name: "r1", type: "all", events: fakeEvents });
  await generateReport({ name: "r2", type: "all", events: fakeEvents });
  const all = await listReports({ limit: 5 });
  assert.ok(all.length >= 2);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].generatedAt >= all[i].generatedAt);
  }
});

test("getReport returns a stored report or null", async () => {
  const r = await generateReport({ name: "retrievable", type: "all", events: fakeEvents });
  const fetched = await getReport(r.id);
  assert.ok(fetched);
  assert.equal(fetched.name, "retrievable");
  assert.equal(await getReport("missing"), null);
});

test("exportCsv formats a report into CSV text", async () => {
  const r = await generateReport({ name: "csv", type: "all", events: fakeEvents });
  const csv = exportCsv(r);
  assert.ok(csv.length > 0);
  // Has header line + content
  const lines = csv.split("\n");
  assert.ok(lines.length > 1);
  assert.ok(lines[0].includes("actor"));
  // Empty report -> empty string
  assert.equal(exportCsv({ rows: [] }), "");
});

test("cancelSchedule disables and listSchedules filters enabledOnly", async () => {
  const s = await scheduleReport({ name: "to-cancel", type: "all", cadence: "daily" });
  await cancelSchedule(s.id);
  const enabled = await listSchedules({ enabledOnly: true });
  assert.ok(!enabled.find((x) => x.id === s.id));
  await assert.rejects(() => cancelSchedule("missing"));
});
