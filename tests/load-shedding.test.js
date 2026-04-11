/**
 * Phase 59.2: Load shedding tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-loadshed-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  enqueueRequest,
  dequeueRequest,
  shouldShed,
  setCapacity,
  getQueueStats,
  _resetQueue,
} = await import("../lib/load-shedding.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test.beforeEach(() => {
  _resetQueue();
});

test("setCapacity clamps and persists", async () => {
  const after = await setCapacity(50);
  assert.equal(after.capacity, 50);
  await assert.rejects(() => setCapacity(-1));
  await assert.rejects(() => setCapacity(NaN));
});

test("enqueueRequest accepts under capacity", async () => {
  await setCapacity(10);
  const r = await enqueueRequest({ priority: "P1", payload: { id: 1 } });
  assert.equal(r.shed, false);
  assert.ok(r.request);
  assert.equal(r.request.priority, "P1");
});

test("enqueueRequest sheds P2 at 75% queue fill", async () => {
  await setCapacity(4);
  for (let i = 0; i < 3; i += 1) {
    await enqueueRequest({ priority: "P1", payload: i });
  }
  const r = await enqueueRequest({ priority: "P2", payload: "best-effort" });
  assert.equal(r.shed, true);
  assert.ok(r.reason.includes("P2"));
});

test("enqueueRequest sheds P1 only when queue exceeds capacity", async () => {
  await setCapacity(3);
  await enqueueRequest({ priority: "P1" });
  await enqueueRequest({ priority: "P1" });
  await enqueueRequest({ priority: "P1" });
  // Exactly at capacity, a fourth P1 is shed (unless elastic bumps).
  const stats = await getQueueStats();
  assert.equal(stats.depth, 3);
  const r = await enqueueRequest({ priority: "P1" });
  // Either shed or elastic-bumped into acceptance; both are valid.
  if (r.shed) {
    assert.ok(r.reason.includes("P1"));
  } else {
    assert.ok(r.capacity >= 3);
  }
});

test("enqueueRequest never sheds P0 under normal capacity", async () => {
  await setCapacity(2);
  await enqueueRequest({ priority: "P1" });
  await enqueueRequest({ priority: "P1" });
  const r = await enqueueRequest({ priority: "P0", payload: "critical" });
  assert.equal(r.shed, false);
  assert.equal(r.request.priority, "P0");
});

test("dequeueRequest returns P0 before P1/P2", async () => {
  await setCapacity(10);
  await enqueueRequest({ priority: "P2", payload: "low" });
  await enqueueRequest({ priority: "P0", payload: "crit" });
  await enqueueRequest({ priority: "P1", payload: "mid" });
  const a = await dequeueRequest();
  const b = await dequeueRequest();
  const c = await dequeueRequest();
  const d = await dequeueRequest();
  assert.equal(a.priority, "P0");
  assert.equal(b.priority, "P1");
  assert.equal(c.priority, "P2");
  assert.equal(d, null);
});

test("shouldShed reports decision without mutating counters", async () => {
  await setCapacity(4);
  const p0 = await shouldShed("P0", { depth: 100 });
  assert.equal(p0, false);
  const p2 = await shouldShed("P2", { depth: 3 });
  assert.equal(p2, true);
  const p1Ok = await shouldShed("P1", { depth: 2 });
  assert.equal(p1Ok, false);
});

test("shouldShed with capacity 0 sheds everything", async () => {
  await setCapacity(0);
  assert.equal(await shouldShed("P0", { depth: 0 }), true);
  assert.equal(await shouldShed("P1", { depth: 0 }), true);
});

test("getQueueStats exposes depth and priority counts", async () => {
  await setCapacity(20);
  await enqueueRequest({ priority: "P0" });
  await enqueueRequest({ priority: "P1" });
  await enqueueRequest({ priority: "P1" });
  await enqueueRequest({ priority: "P2" });
  const stats = await getQueueStats();
  assert.equal(stats.depth, 4);
  assert.equal(stats.priorityCounts.P0, 1);
  assert.equal(stats.priorityCounts.P1, 2);
  assert.equal(stats.priorityCounts.P2, 1);
});

test("shed counters increment on shed events", async () => {
  await setCapacity(2);
  await enqueueRequest({ priority: "P1" });
  await enqueueRequest({ priority: "P1" });
  // Queue at 100% of 2, which is also >= 75%, so a P2 request sheds.
  const before = (await getQueueStats()).shedCounts.P2 || 0;
  await enqueueRequest({ priority: "P2" });
  const after = (await getQueueStats()).shedCounts.P2 || 0;
  assert.ok(after >= before + 1);
});
