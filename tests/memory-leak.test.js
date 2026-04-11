/**
 * Phase 60.2: memory-leak tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-memleak-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  takeSnapshot,
  diffSnapshots,
  detectLeaks,
  listSnapshots,
  clearSnapshots,
  getSnapshot,
  computeDiff,
  normalizeRecords,
  synthesizeRecords,
} = await import("../lib/memory-leak.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("normalizeRecords groups by objectType and sums", () => {
  const recs = normalizeRecords([
    { objectType: "Foo", count: 5, size: 100 },
    { objectType: "Foo", count: 3, size: 50 },
    { objectType: "Bar", count: 1, size: 1000 },
  ]);
  assert.equal(recs.length, 2);
  const foo = recs.find((r) => r.objectType === "Foo");
  assert.equal(foo.count, 8);
  assert.equal(foo.size, 150);
});

test("normalizeRecords handles bogus input", () => {
  assert.deepEqual(normalizeRecords(null), []);
  assert.deepEqual(normalizeRecords("not an array"), []);
  assert.deepEqual(normalizeRecords([null, {}, { count: 1 }]), []);
});

test("synthesizeRecords uses injected memoryUsage", () => {
  const out = synthesizeRecords(() => /** @type {any} */ ({
    rss: 1000,
    heapUsed: 500,
    heapTotal: 800,
    external: 50,
    arrayBuffers: 25,
  }));
  const map = Object.fromEntries(out.map((r) => [r.objectType, r.size]));
  assert.equal(map.rss, 1000);
  assert.equal(map.heap_used, 500);
  assert.equal(map.array_buffers, 25);
});

test("takeSnapshot persists and listSnapshots returns it", async () => {
  const snap = await takeSnapshot({
    label: "baseline",
    records: [{ objectType: "Widget", count: 10, size: 1000 }],
  });
  assert.ok(snap.id);
  assert.equal(snap.label, "baseline");
  assert.equal(snap.totalSize, 1000);
  const list = await listSnapshots();
  assert.ok(list.some((s) => s.id === snap.id));
  const full = await getSnapshot(snap.id);
  assert.ok(full);
  assert.equal(full.records.length, 1);
});

test("takeSnapshot synthesizes when no records provided", async () => {
  const snap = await takeSnapshot({
    label: "synth",
    memoryUsage: () => /** @type {any} */ ({ rss: 500, heapUsed: 300, heapTotal: 400, external: 10 }),
  });
  assert.ok(snap.totalSize > 0);
  assert.ok(snap.records.length > 0);
});

test("computeDiff shows growth and shrinkage", () => {
  const before = { records: [{ objectType: "A", count: 1, size: 100 }, { objectType: "B", count: 5, size: 500 }] };
  const after = { records: [{ objectType: "A", count: 10, size: 1000 }, { objectType: "B", count: 3, size: 300 }] };
  const diff = computeDiff(before, after);
  assert.equal(diff.rows.length, 2);
  const a = diff.rows.find((r) => r.objectType === "A");
  assert.equal(a.deltaSize, 900);
  assert.equal(a.deltaCount, 9);
  const b = diff.rows.find((r) => r.objectType === "B");
  assert.equal(b.deltaSize, -200);
  assert.equal(diff.growingTypes, 1);
  assert.equal(diff.shrinkingTypes, 1);
});

test("diffSnapshots loads from store and diffs", async () => {
  const s1 = await takeSnapshot({
    label: "s1",
    records: [{ objectType: "X", count: 1, size: 100 }],
  });
  const s2 = await takeSnapshot({
    label: "s2",
    records: [{ objectType: "X", count: 2, size: 200 }],
  });
  const diff = await diffSnapshots(s1.id, s2.id);
  assert.equal(diff.totalDeltaSize, 100);
  assert.equal(diff.rows[0].objectType, "X");
});

test("diffSnapshots throws for missing snapshots", async () => {
  await assert.rejects(() => diffSnapshots("none", "also-none"));
});

test("detectLeaks flags monotonically growing types", async () => {
  await clearSnapshots();
  for (let i = 1; i <= 5; i += 1) {
    await takeSnapshot({
      label: `g${i}`,
      records: [
        { objectType: "Leaky", count: i, size: i * 10000 },
        { objectType: "Stable", count: 3, size: 5000 },
      ],
    });
  }
  const result = await detectLeaks({ windowSize: 5, minGrowthBytes: 1000, minGrowthRatio: 1.5 });
  assert.ok(result.leaks.length >= 1);
  const leaky = result.leaks.find((l) => l.objectType === "Leaky");
  assert.ok(leaky);
  assert.ok(leaky.monotonic);
  assert.equal(leaky.firstSize, 10000);
  assert.equal(leaky.lastSize, 50000);
  assert.ok(!result.leaks.some((l) => l.objectType === "Stable"));
});

test("detectLeaks returns empty for < 2 snapshots", async () => {
  await clearSnapshots();
  const result = await detectLeaks();
  assert.equal(result.leaks.length, 0);
  await takeSnapshot({ label: "one", records: [{ objectType: "A", count: 1, size: 10 }] });
  const r2 = await detectLeaks();
  assert.equal(r2.analyzed, 1);
  assert.equal(r2.leaks.length, 0);
});

test("detectLeaks ignores non-monotonic series", async () => {
  await clearSnapshots();
  const sizes = [1000, 2000, 1500, 2500, 3000];
  for (let i = 0; i < sizes.length; i += 1) {
    await takeSnapshot({
      label: `nm${i}`,
      records: [{ objectType: "Wobbly", count: 1, size: sizes[i] }],
    });
  }
  const result = await detectLeaks({ windowSize: 5, minGrowthBytes: 100 });
  assert.ok(!result.leaks.some((l) => l.objectType === "Wobbly"));
});

test("clearSnapshots removes one and all snapshots", async () => {
  await clearSnapshots();
  const a = await takeSnapshot({ label: "a", records: [{ objectType: "X", count: 1, size: 10 }] });
  const b = await takeSnapshot({ label: "b", records: [{ objectType: "Y", count: 1, size: 20 }] });
  await clearSnapshots(a.id);
  const listed = await listSnapshots();
  assert.ok(!listed.some((s) => s.id === a.id));
  assert.ok(listed.some((s) => s.id === b.id));
  await clearSnapshots();
  const empty = await listSnapshots();
  assert.equal(empty.length, 0);
});
