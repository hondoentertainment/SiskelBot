/**
 * Phase 60.2: Heap diff tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-heap-diff-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  takeSnapshot,
  getSnapshot,
  listSnapshots,
  deleteSnapshot,
  diffSnapshots,
  diffSummaries,
  summarizeHeapSnapshot,
  KNOWN_NODE_TYPES,
} = await import("../lib/heap-diff.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ─── Known types ─────────────────────────────────────────────────────────

test("KNOWN_NODE_TYPES includes common heap types", () => {
  for (const t of ["array", "string", "object", "closure", "code"]) {
    assert.ok(KNOWN_NODE_TYPES.includes(t), `missing ${t}`);
  }
});

// ─── summarizeHeapSnapshot ───────────────────────────────────────────────

test("summarizeHeapSnapshot aggregates counts by type and constructor", () => {
  const snapshot = {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"],
        node_types: [["hidden", "array", "string", "object"]],
      },
    },
    // Each node = 7 fields. type index 0 + 1 + 2 + 3 = hidden, array, string, object.
    nodes: [
      // array node
      1, 0, 1, 100, 0, 0, 0,
      // string node
      2, 0, 2, 50, 0, 0, 0,
      // object node ctor=MyObj (index 1)
      3, 1, 3, 200, 0, 0, 0,
      // another object ctor=Object (index 0)
      3, 0, 4, 150, 0, 0, 0,
    ],
    strings: ["Object", "MyObj"],
  };
  const summary = summarizeHeapSnapshot(snapshot);
  assert.equal(summary.totalNodes, 4);
  assert.equal(summary.totalSize, 500);
  assert.equal(summary.byType.array, 1);
  assert.equal(summary.byType.string, 1);
  assert.equal(summary.byType.object, 2);
  assert.equal(summary.byConstructor.MyObj, 1);
  assert.equal(summary.byConstructor.Object, 1);
});

test("summarizeHeapSnapshot returns empty summary for null input", () => {
  const s = summarizeHeapSnapshot(null);
  assert.equal(s.totalNodes, 0);
  assert.equal(s.totalSize, 0);
  assert.deepEqual(s.byType, {});
});

// ─── takeSnapshot / getSnapshot / listSnapshots ─────────────────────────

test("takeSnapshot persists a summary with counts and sizes", async () => {
  const rec = await takeSnapshot({ label: "first" });
  assert.ok(rec.id);
  assert.equal(rec.label, "first");
  assert.ok(rec.totalNodes > 0);
  assert.ok(rec.totalSize > 0);
  assert.ok(rec.byType && typeof rec.byType === "object");
  const loaded = await getSnapshot(rec.id);
  assert.equal(loaded.id, rec.id);
});

test("listSnapshots returns persisted snapshots newest-first", async () => {
  const a = await takeSnapshot({ label: "a", tag: "x" });
  const b = await takeSnapshot({ label: "b", tag: "x" });
  const list = await listSnapshots({ tag: "x" });
  assert.ok(list.length >= 2);
  // newest should be b since it was taken second.
  assert.equal(list[0].id, b.id);
  assert.ok(list.some((s) => s.id === a.id));
});

test("deleteSnapshot removes a snapshot", async () => {
  const rec = await takeSnapshot({ label: "del" });
  const result = await deleteSnapshot(rec.id);
  assert.equal(result.ok, true);
  const after = await getSnapshot(rec.id);
  assert.equal(after, null);
});

// ─── Diff ────────────────────────────────────────────────────────────────

test("diffSummaries computes per-type and per-constructor deltas", () => {
  const before = {
    id: "a", at: "2024-01-01T00:00:00Z", totalNodes: 100, totalSize: 1000,
    byType: { array: 10, object: 20, string: 5 },
    byConstructor: { Array: 10, Object: 20 },
  };
  const after = {
    id: "b", at: "2024-01-01T00:01:00Z", totalNodes: 180, totalSize: 3000,
    byType: { array: 15, object: 50, string: 8 },
    byConstructor: { Array: 15, Object: 50, Promise: 10 },
  };
  const diff = diffSummaries(before, after, { minDelta: 1 });
  assert.equal(diff.delta.nodes, 80);
  assert.equal(diff.delta.size, 2000);
  assert.equal(diff.byType.object.delta, 30);
  assert.equal(diff.byConstructor.Object.delta, 30);
  assert.equal(diff.byConstructor.Promise.delta, 10);
  assert.ok(Array.isArray(diff.topGrowers));
  assert.ok(diff.topGrowers.length > 0);
  // top grower should be one with largest delta
  assert.equal(diff.topGrowers[0].delta, 30);
});

test("diffSummaries flags Object/Array/String growers over 1000", () => {
  const before = {
    id: "a", at: "2024-01-01T00:00:00Z", totalNodes: 10, totalSize: 100,
    byType: {}, byConstructor: { Array: 5 },
  };
  const after = {
    id: "b", at: "2024-01-01T00:01:00Z", totalNodes: 20_000, totalSize: 20_000_000,
    byType: {}, byConstructor: { Array: 2000 },
  };
  const diff = diffSummaries(before, after);
  const kinds = diff.flags.map((f) => f.kind);
  assert.ok(kinds.includes("constructor_growth"));
  assert.ok(kinds.includes("size_growth"));
  assert.ok(kinds.includes("node_growth"));
});

test("diffSnapshots throws when either snapshot is missing", async () => {
  await assert.rejects(() => diffSnapshots("missing-1", "missing-2"));
});

test("diffSnapshots works with two real snapshots", async () => {
  const a = await takeSnapshot({ label: "pre" });
  // Allocate a bunch of objects to grow the heap
  const holders = [];
  for (let i = 0; i < 5000; i += 1) {
    holders.push({ a: i, b: "val-" + i, c: [i, i + 1] });
  }
  const b = await takeSnapshot({ label: "post" });
  const diff = await diffSnapshots(a.id, b.id);
  assert.equal(diff.before.id, a.id);
  assert.equal(diff.after.id, b.id);
  assert.ok("byType" in diff);
  assert.ok("byConstructor" in diff);
  // reference holders so V8 doesn't GC before snapshot
  assert.equal(holders.length, 5000);
});

// ─── topN limit ──────────────────────────────────────────────────────────

test("diffSummaries respects topN", () => {
  const before = { id: "a", at: "", totalNodes: 0, totalSize: 0, byType: {}, byConstructor: {} };
  const after = {
    id: "b", at: "", totalNodes: 0, totalSize: 0,
    byType: { a: 100, b: 90, c: 80, d: 70, e: 60 },
    byConstructor: {},
  };
  const diff = diffSummaries(before, after, { topN: 2, minDelta: 1 });
  assert.equal(diff.topGrowers.length, 2);
  assert.equal(diff.topGrowers[0].name, "a");
});
