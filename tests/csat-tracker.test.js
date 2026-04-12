/**
 * Phase 62.5: CSAT tracker tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-csat-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordFeedback,
  listFeedback,
  getCsatReport,
  _internals,
} = await import("../lib/csat-tracker.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("recordFeedback requires ticketId and csat or nps", async () => {
  await assert.rejects(() => recordFeedback({}), /ticketId is required/);
  await assert.rejects(() => recordFeedback({ ticketId: "t" }), /csat or nps is required/);
});

test("recordFeedback validates csat range 1..5", async () => {
  await assert.rejects(
    () => recordFeedback({ ticketId: "t", csat: 0 }),
    /csat must be between 1 and 5/,
  );
  await assert.rejects(
    () => recordFeedback({ ticketId: "t", csat: 6 }),
    /csat must be between 1 and 5/,
  );
});

test("recordFeedback validates nps range 0..10", async () => {
  await assert.rejects(
    () => recordFeedback({ ticketId: "t", nps: -1 }),
    /nps must be between 0 and 10/,
  );
  await assert.rejects(
    () => recordFeedback({ ticketId: "t", nps: 11 }),
    /nps must be between 0 and 10/,
  );
});

test("recordFeedback accepts valid entries and listFeedback returns them", async () => {
  await recordFeedback({ ticketId: "t1", agentId: "a1", csat: 5, nps: 10 });
  await recordFeedback({ ticketId: "t2", agentId: "a2", csat: 4 });
  await recordFeedback({ ticketId: "t3", agentId: "a1", nps: 9, comment: "great" });
  const items = await listFeedback();
  assert.ok(items.length >= 3);
});

test("listFeedback filters by agentId and ticketId", async () => {
  const a1 = await listFeedback({ agentId: "a1" });
  assert.ok(a1.every((e) => e.agentId === "a1"));
  const t = await listFeedback({ ticketId: "t2" });
  assert.ok(t.every((e) => e.ticketId === "t2"));
});

test("getCsatReport computes csat average and distribution", async () => {
  const report = await getCsatReport();
  assert.ok(report.overall.csatResponses >= 2);
  assert.ok(typeof report.overall.csatAverage === "number");
  const dist = report.overall.csatDistribution;
  assert.ok(Object.keys(dist).length === 5);
});

test("getCsatReport computes NPS with promoters/detractors", async () => {
  // Reset storage for deterministic NPS calc — use a fresh tmpdir.
  const freshDir = mkdtempSync(join(tmpdir(), "siskel-csat-fresh-"));
  const save = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = freshDir;
  try {
    const { recordFeedback: rec, getCsatReport: rep } = await import(
      `../lib/csat-tracker.js?fresh=${Date.now()}`
    );
    await rec({ ticketId: "n1", nps: 10 }); // promoter
    await rec({ ticketId: "n2", nps: 9 });  // promoter
    await rec({ ticketId: "n3", nps: 7 });  // passive
    await rec({ ticketId: "n4", nps: 3 });  // detractor
    const r = await rep();
    assert.equal(r.overall.promoters, 2);
    assert.equal(r.overall.passives, 1);
    assert.equal(r.overall.detractors, 1);
    // (2 - 1) / 4 = 0.25 → 25
    assert.equal(r.overall.npsScore, 25);
  } finally {
    process.env.STORAGE_PATH = save;
    try { rmSync(freshDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test("getCsatReport produces per-agent rollups sorted by csat", async () => {
  const report = await getCsatReport();
  const perAgent = report.perAgent;
  assert.ok(Array.isArray(perAgent));
  // For any agent with multiple csat values, average should be numeric.
  for (const row of perAgent) {
    assert.ok(typeof row.agentId === "string");
    assert.ok(typeof row.totalFeedback === "number");
  }
  // Sorted descending by csatAverage (null treated as 0).
  for (let i = 1; i < perAgent.length; i++) {
    assert.ok((perAgent[i - 1].csatAverage ?? 0) >= (perAgent[i].csatAverage ?? 0));
  }
});

test("getCsatReport returns a daily trend array", async () => {
  const report = await getCsatReport({ trendDays: 30 });
  assert.ok(Array.isArray(report.trend));
  // Each trend bucket must have required fields.
  for (const b of report.trend) {
    assert.ok(typeof b.day === "string");
    assert.ok(typeof b.total === "number");
  }
});

test("internal avg and computeNps helpers are correct", () => {
  assert.equal(_internals.avg([1, 2, 3]), 2);
  assert.equal(_internals.avg([]), null);
  assert.equal(_internals.computeNps([9, 10, 6, 0]), 0); // 2 promoters, 2 detractors, 0 of 4
  assert.equal(_internals.computeNps([10]), 100);
  assert.equal(_internals.computeNps([]), null);
});

test("listFeedback respects the since filter", async () => {
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const items = await listFeedback({ since: future });
  assert.equal(items.length, 0);
});
