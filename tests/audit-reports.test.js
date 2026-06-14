/**
 * Phase 65.4: Audit report tests — templates, definitions, generation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-audit-reports-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  defineReport,
  getReport,
  listReports,
  scheduleReport,
  generateReport,
  getRun,
  listRuns,
  TEMPLATE_SOC2_ACCESS,
  TEMPLATE_GDPR_DSR,
  TEMPLATE_USAGE_SUMMARY,
} = await import("../lib/audit-reports.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("defineReport requires name and template", async () => {
  await assert.rejects(() => defineReport({}), /name/);
  await assert.rejects(() => defineReport({ name: "r" }), /template/);
});

test("defineReport persists and listReports retrieves", async () => {
  const rec = await defineReport({ name: "monthly-soc2", template: TEMPLATE_SOC2_ACCESS });
  assert.ok(rec.id);
  assert.equal(rec.template, TEMPLATE_SOC2_ACCESS);
  const fetched = await getReport(rec.id);
  assert.equal(fetched.id, rec.id);
  const list = await listReports({ template: TEMPLATE_SOC2_ACCESS });
  assert.ok(list.some((r) => r.id === rec.id));
});

test("scheduleReport updates schedule and nextRunAt", async () => {
  const rec = await defineReport({ name: "sch", template: TEMPLATE_USAGE_SUMMARY });
  const updated = await scheduleReport(rec.id, { schedule: "0 0 1 * *", nextRunAt: "2026-05-01T00:00:00Z" });
  assert.equal(updated.schedule, "0 0 1 * *");
  assert.equal(updated.nextRunAt, "2026-05-01T00:00:00.000Z");
});

test("generateReport SOC2 groups events by user with allow/deny counts", async () => {
  const rec = await defineReport({ name: "soc2", template: TEMPLATE_SOC2_ACCESS });
  const events = [
    { at: "2026-04-01T10:00:00Z", user: "alice", outcome: "allowed" },
    { at: "2026-04-01T11:00:00Z", user: "alice", outcome: "denied" },
    { at: "2026-04-01T12:00:00Z", user: "bob", outcome: "allowed" },
    { at: "2026-04-01T13:00:00Z", user: "bob", outcome: "allowed" },
  ];
  const run = await generateReport(rec.id, { events, periodStart: "2026-04-01T00:00:00Z", periodEnd: "2026-05-01T00:00:00Z" });
  assert.equal(run.eventCount, 4);
  assert.equal(run.output.totals.allowed, 3);
  assert.equal(run.output.totals.denied, 1);
  const alice = run.output.byUser.find((u) => u.user === "alice");
  assert.equal(alice.allowed, 1);
  assert.equal(alice.denied, 1);
});

test("generateReport GDPR DSR groups by requestKind", async () => {
  const rec = await defineReport({ name: "gdpr", template: TEMPLATE_GDPR_DSR });
  const events = [
    { at: "2026-04-01T10:00:00Z", requestKind: "export", subject: "alice", status: "fulfilled" },
    { at: "2026-04-02T10:00:00Z", requestKind: "delete", subject: "bob", status: "pending" },
    { at: "2026-04-03T10:00:00Z", requestKind: "export", subject: "carol", status: "fulfilled" },
  ];
  const run = await generateReport(rec.id, { events });
  assert.equal(run.output.totals.requests, 3);
  assert.equal(run.output.byKind.export, 2);
  assert.equal(run.output.byKind.delete, 1);
  assert.ok(run.output.requests.some((r) => r.subject === "alice"));
});

test("generateReport usage-summary aggregates cost and tokens", async () => {
  const rec = await defineReport({ name: "usage", template: TEMPLATE_USAGE_SUMMARY });
  const events = [
    { at: "2026-04-01T10:00:00Z", type: "chat", costUsd: 0.03, tokens: 500 },
    { at: "2026-04-01T11:00:00Z", type: "chat", costUsd: 0.05, tokens: 800 },
    { at: "2026-04-01T12:00:00Z", type: "embedding", costUsd: 0.001, tokens: 200 },
  ];
  const run = await generateReport(rec.id, { events });
  assert.equal(run.output.totals.events, 3);
  assert.ok(Math.abs(run.output.totals.totalCostUsd - 0.081) < 1e-9);
  assert.equal(run.output.totals.totalTokens, 1500);
  assert.equal(run.output.byType.chat, 2);
  assert.equal(run.output.byType.embedding, 1);
});

test("generateReport respects period filter", async () => {
  const rec = await defineReport({ name: "p", template: TEMPLATE_USAGE_SUMMARY });
  const events = [
    { at: "2026-03-31T23:59:00Z", type: "chat" },
    { at: "2026-04-01T00:00:00Z", type: "chat" },
    { at: "2026-04-30T23:59:00Z", type: "chat" },
    { at: "2026-05-01T00:00:00Z", type: "chat" },
  ];
  const run = await generateReport(rec.id, { events, periodStart: "2026-04-01T00:00:00Z", periodEnd: "2026-05-01T00:00:00Z" });
  assert.equal(run.eventCount, 2);
});

test("generateReport applies custom filter fields", async () => {
  const rec = await defineReport({
    name: "type-filter",
    template: TEMPLATE_USAGE_SUMMARY,
    filter: { type: "chat" },
  });
  const events = [
    { at: "2026-04-01T10:00:00Z", type: "chat" },
    { at: "2026-04-01T10:10:00Z", type: "embedding" },
    { at: "2026-04-01T10:20:00Z", type: "chat" },
  ];
  const run = await generateReport(rec.id, { events });
  assert.equal(run.eventCount, 2);
  assert.equal(run.output.byType.chat, 2);
  assert.equal(run.output.byType.embedding, undefined);
});

test("generateReport appends runIds to definition and listRuns returns them", async () => {
  const rec = await defineReport({ name: "multi-run", template: TEMPLATE_USAGE_SUMMARY });
  await generateReport(rec.id, { events: [{ at: "2026-04-01T10:00:00Z", type: "a" }] });
  await generateReport(rec.id, { events: [{ at: "2026-04-02T10:00:00Z", type: "b" }] });
  const after = await getReport(rec.id);
  assert.equal(after.runIds.length, 2);
  assert.ok(after.lastRunAt);
  const runs = await listRuns({ definitionId: rec.id });
  assert.equal(runs.length, 2);
  const first = await getRun(runs[0].id);
  assert.equal(first.definitionId, rec.id);
});

test("generateReport on missing definition throws NOT_FOUND", async () => {
  await assert.rejects(() => generateReport("missing", { events: [] }), /not found/);
});
