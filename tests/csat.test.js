/**
 * Phase 62.5: CSAT tracking tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-csat-"));
process.env.STORAGE_PATH = TMP;

const {
  recordFeedback,
  getCsatScore,
  getTrend,
  listFeedback,
  exportCsv,
} = await import("../lib/csat.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("recordFeedback stores a rating", async () => {
  const rec = await recordFeedback({ rating: 5, agentId: "alice", ticketId: "t1", comment: "great!" });
  assert.equal(rec.rating, 5);
  assert.equal(rec.agentId, "alice");
  assert.ok(rec.id);
  assert.ok(rec.createdAt);
});

test("recordFeedback rejects invalid rating", async () => {
  await assert.rejects(() => recordFeedback({ rating: 0 }));
  await assert.rejects(() => recordFeedback({ rating: 6 }));
  await assert.rejects(() => recordFeedback({ rating: "oops" }));
  await assert.rejects(() => recordFeedback(null));
});

test("getCsatScore returns overall score", async () => {
  await recordFeedback({ rating: 4, agentId: "alice" });
  await recordFeedback({ rating: 3, agentId: "alice" });
  await recordFeedback({ rating: 2, agentId: "bob" });
  const out = await getCsatScore();
  assert.ok(out.total >= 4);
  assert.ok(out.avgRating > 0);
});

test("getCsatScore can filter by agentId", async () => {
  const alice = await getCsatScore({ agentId: "alice" });
  const bob = await getCsatScore({ agentId: "bob" });
  assert.ok(alice.total >= 3);
  assert.ok(bob.total >= 1);
});

test("getCsatScore returns zeros for empty filter", async () => {
  const out = await getCsatScore({ agentId: "nobody" });
  assert.equal(out.score, 0);
  assert.equal(out.total, 0);
  assert.equal(out.avgRating, 0);
});

test("getTrend daily buckets", async () => {
  const trend = await getTrend({ bucket: "daily" });
  assert.ok(Array.isArray(trend));
  assert.ok(trend.length >= 1);
  for (const b of trend) {
    assert.ok(b.date);
    assert.ok(b.total > 0);
  }
});

test("getTrend weekly buckets", async () => {
  const trend = await getTrend({ bucket: "weekly" });
  assert.ok(Array.isArray(trend));
  if (trend.length > 0) {
    assert.ok(trend[0].date.includes("W"));
  }
});

test("listFeedback paginates", async () => {
  const page1 = await listFeedback({ limit: 2, offset: 0 });
  assert.ok(page1.items.length <= 2);
  assert.ok(page1.total >= 4);
});

test("listFeedback filters by agent", async () => {
  const out = await listFeedback({ agentId: "alice" });
  assert.ok(out.items.every((f) => f.agentId === "alice"));
});

test("exportCsv produces a header and rows", async () => {
  const csv = await exportCsv();
  assert.ok(csv.startsWith("id,rating,ticketId,agentId,customerId,createdAt,comment"));
  const lines = csv.split("\n");
  assert.ok(lines.length > 1);
});

test("exportCsv escapes commas/quotes", async () => {
  await recordFeedback({ rating: 5, comment: 'has, "commas" and quotes' });
  const csv = await exportCsv();
  assert.ok(csv.includes('""commas""'));
});
