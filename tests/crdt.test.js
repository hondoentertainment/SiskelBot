/**
 * Phase 41.1: tests for lib/crdt.js — LWWRegister, ORSet, RGA, HLC, and
 * createCRDTDocument convergence semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HybridLogicalClock,
  LWWRegister,
  ORSet,
  RGA,
  createCRDTDocument,
} from "../lib/crdt.js";
import { createSyncManager } from "../lib/crdt-sync.js";

// ─── HybridLogicalClock ─────────────────────────────────────────────────────

test("HLC: tick produces monotonically increasing timestamps", () => {
  const clock = new HybridLogicalClock("nodeA");
  const a = clock.tick();
  const b = clock.tick();
  const c = clock.tick();
  assert.ok(HybridLogicalClock.compare(a, b) < 0);
  assert.ok(HybridLogicalClock.compare(b, c) < 0);
});

test("HLC: update advances past a remote timestamp", () => {
  const clock = new HybridLogicalClock("nodeA");
  const remote = { physical: Date.now() + 10_000, logical: 5, node: "nodeB" };
  const merged = clock.update(remote);
  assert.ok(HybridLogicalClock.compare(merged, remote) > 0);
  assert.equal(merged.physical >= remote.physical, true);
});

test("HLC: compare uses physical, then logical, then node", () => {
  assert.ok(HybridLogicalClock.compare({ physical: 1, logical: 0, node: "a" }, { physical: 2, logical: 0, node: "a" }) < 0);
  assert.ok(HybridLogicalClock.compare({ physical: 5, logical: 0, node: "a" }, { physical: 5, logical: 1, node: "a" }) < 0);
  assert.ok(HybridLogicalClock.compare({ physical: 5, logical: 1, node: "a" }, { physical: 5, logical: 1, node: "b" }) < 0);
  assert.equal(HybridLogicalClock.compare({ physical: 5, logical: 1, node: "a" }, { physical: 5, logical: 1, node: "a" }), 0);
});

// ─── LWWRegister ────────────────────────────────────────────────────────────

test("LWWRegister: latest write wins by clock", () => {
  const reg = new LWWRegister("init", { physical: 1, logical: 0, node: "a" });
  reg.set("v2", { physical: 2, logical: 0, node: "a" });
  assert.equal(reg.get(), "v2");
  // Older clock is ignored
  reg.set("stale", { physical: 1, logical: 5, node: "a" });
  assert.equal(reg.get(), "v2");
});

test("LWWRegister: merge of two registers converges (commutative)", () => {
  const a = new LWWRegister("a", { physical: 1, logical: 0, node: "n1" });
  const b = new LWWRegister("b", { physical: 2, logical: 0, node: "n2" });
  const a2 = new LWWRegister("a", { physical: 1, logical: 0, node: "n1" });
  const b2 = new LWWRegister("b", { physical: 2, logical: 0, node: "n2" });
  a.merge(b);
  b2.merge(a2);
  assert.equal(a.get(), b2.get());
  assert.equal(a.get(), "b");
});

test("LWWRegister: serialize/deserialize round trip", () => {
  const reg = new LWWRegister(42, { physical: 99, logical: 1, node: "x" });
  const data = reg.serialize();
  const restored = LWWRegister.deserialize(data);
  assert.equal(restored.get(), 42);
  assert.deepEqual(restored.clock, { physical: 99, logical: 1, node: "x" });
});

// ─── ORSet ──────────────────────────────────────────────────────────────────

test("ORSet: add then has returns true", () => {
  const set = new ORSet();
  set.add("apple");
  assert.equal(set.has("apple"), true);
  assert.deepEqual(set.values(), ["apple"]);
});

test("ORSet: remove only removes observed tags (concurrent add wins)", () => {
  const a = new ORSet();
  const b = new ORSet();
  a.add("x", "tag-1");
  // b doesn't observe tag-1; b.remove is a no-op for unknown tags
  b.remove("x");
  // Now b independently adds with a different tag
  b.add("x", "tag-2");
  // Merge: union of adds, union of removes
  a.merge(b);
  b.merge(a);
  assert.equal(a.has("x"), true);
  assert.equal(b.has("x"), true);
});

test("ORSet: add+remove on same replica yields removal", () => {
  const set = new ORSet();
  const id = set.add("y");
  set.remove("y", id);
  assert.equal(set.has("y"), false);
});

test("ORSet: merge is commutative", () => {
  const a = new ORSet();
  const b = new ORSet();
  a.add("alpha", "ta1");
  a.add("beta", "tb1");
  b.add("beta", "tb2");
  b.add("gamma", "tg1");
  b.remove("alpha", "ta1"); // b never observed ta1; this is a no-op
  const a2 = new ORSet();
  a2.merge(a);
  a2.merge(b);
  const b2 = new ORSet();
  b2.merge(b);
  b2.merge(a);
  assert.deepEqual(a2.values().sort(), b2.values().sort());
});

test("ORSet: serialize/deserialize round trip", () => {
  const set = new ORSet();
  set.add("foo", "id-1");
  set.add("bar", "id-2");
  set.remove("bar", "id-2");
  const restored = ORSet.deserialize(set.serialize());
  assert.deepEqual(restored.values(), ["foo"]);
});

// ─── RGA ────────────────────────────────────────────────────────────────────

function tsFor(node, physical, logical = 0) {
  return { physical, logical, node };
}

test("RGA: append produces correct order", () => {
  const rga = new RGA();
  rga.append("a", tsFor("n1", 1));
  rga.append("b", tsFor("n1", 2));
  rga.append("c", tsFor("n1", 3));
  assert.deepEqual(rga.toArray(), ["a", "b", "c"]);
});

test("RGA: insert at index", () => {
  const rga = new RGA();
  rga.insert(0, "a", tsFor("n1", 1));
  rga.insert(1, "c", tsFor("n1", 2));
  rga.insert(1, "b", tsFor("n1", 3));
  assert.deepEqual(rga.toArray(), ["a", "b", "c"]);
});

test("RGA: delete tombstones items", () => {
  const rga = new RGA();
  const k1 = rga.append("a", tsFor("n1", 1));
  const k2 = rga.append("b", tsFor("n1", 2));
  const k3 = rga.append("c", tsFor("n1", 3));
  rga.delete(k2);
  assert.deepEqual(rga.toArray(), ["a", "c"]);
  // Idempotent
  assert.equal(rga.delete(k2), false);
  assert.equal(typeof k1, "string");
  assert.equal(typeof k3, "string");
});

test("RGA: concurrent inserts at same anchor converge", () => {
  // Two replicas independently insert at index 0 of an empty list.
  const a = new RGA();
  const b = new RGA();
  a.insert(0, "A", tsFor("nA", 10));
  b.insert(0, "B", tsFor("nB", 11));
  // Merge in both directions
  a.merge(b);
  b.merge(a);
  assert.deepEqual(a.toArray(), b.toArray());
});

test("RGA: merge is commutative across many ops", () => {
  const a = new RGA();
  const b = new RGA();
  a.append("x", tsFor("n1", 1));
  b.append("y", tsFor("n2", 2));
  a.append("z", tsFor("n1", 3));
  b.append("w", tsFor("n2", 4));
  const ab = new RGA();
  ab.merge(a);
  ab.merge(b);
  const ba = new RGA();
  ba.merge(b);
  ba.merge(a);
  assert.deepEqual(ab.toArray(), ba.toArray());
});

test("RGA: serialize/deserialize round trip", () => {
  const rga = new RGA();
  rga.append("hello", tsFor("n1", 1));
  rga.append("world", tsFor("n1", 2));
  const data = rga.serialize();
  const restored = RGA.deserialize(data);
  assert.deepEqual(restored.toArray(), ["hello", "world"]);
});

// ─── createCRDTDocument ────────────────────────────────────────────────────

test("CRDT doc: set/get on a default LWW field", () => {
  const doc = createCRDTDocument("doc-1");
  doc.set("title", "first");
  assert.equal(doc.get("title"), "first");
  doc.set("title", "second");
  assert.equal(doc.get("title"), "second");
  assert.ok(doc.getOps().length >= 2);
});

test("CRDT doc: ORSet helpers via addToSet/removeFromSet", () => {
  const doc = createCRDTDocument("doc-2");
  doc.createField("tags", "ORSet");
  const id = doc.addToSet("tags", "urgent");
  doc.addToSet("tags", "review");
  assert.deepEqual(doc.get("tags").sort(), ["review", "urgent"]);
  doc.removeFromSet("tags", "urgent", [id]);
  assert.deepEqual(doc.get("tags"), ["review"]);
});

test("CRDT doc: RGA helpers via rgaInsert/rgaDelete", () => {
  const doc = createCRDTDocument("doc-3");
  doc.createField("body", "RGA");
  const k1 = doc.rgaInsert("body", 0, "H");
  doc.rgaInsert("body", 1, "i");
  doc.rgaInsert("body", 2, "!");
  assert.deepEqual(doc.get("body"), ["H", "i", "!"]);
  doc.rgaDelete("body", k1);
  assert.deepEqual(doc.get("body"), ["i", "!"]);
});

test("CRDT doc: concurrent edits converge after merge", () => {
  const docA = createCRDTDocument("doc-4", { nodeId: "node-A" });
  const docB = createCRDTDocument("doc-4", { nodeId: "node-B" });
  docA.createField("title", "LWWRegister");
  docB.createField("title", "LWWRegister");
  docA.set("title", "from A");
  docB.set("title", "from B");

  // Each side replays the other's ops
  for (const op of docB.getOps()) docA.applyOp(op);
  for (const op of docA.getOps()) docB.applyOp(op);
  assert.equal(docA.get("title"), docB.get("title"));
});

test("CRDT doc: applyOp ignores unknown ops gracefully", () => {
  const doc = createCRDTDocument("doc-5");
  assert.equal(doc.applyOp(null), false);
  assert.equal(doc.applyOp({}), false);
  assert.equal(doc.applyOp({ kind: "wat", field: "x" }), false);
});

test("CRDT doc: getOps(since) filters by clock", () => {
  const doc = createCRDTDocument("doc-6");
  doc.set("k", 1);
  const mid = doc.clock.tick();
  doc.set("k", 2);
  doc.set("k", 3);
  const ops = doc.getOps(mid);
  assert.ok(ops.length >= 2);
  for (const op of ops) {
    assert.ok(HybridLogicalClock.compare(op.clock, mid) > 0);
  }
});

test("CRDT doc: snapshot serializes all field types", () => {
  const doc = createCRDTDocument("doc-7");
  doc.set("title", "hello");
  doc.createField("tags", "ORSet");
  doc.addToSet("tags", "x");
  doc.createField("body", "RGA");
  doc.rgaInsert("body", 0, "a");
  const snap = doc.snapshot();
  assert.equal(snap.id, "doc-7");
  assert.equal(snap.fields.title.type, "LWWRegister");
  assert.equal(snap.fields.tags.type, "ORSet");
  assert.equal(snap.fields.body.type, "RGA");
});

// ─── createSyncManager ─────────────────────────────────────────────────────

test("syncManager: broadcasts ops via the configured callback", async () => {
  const sent = [];
  const sync = createSyncManager({
    broadcast: (msg) => {
      sent.push(msg);
    },
  });
  const doc = createCRDTDocument("doc-sync-1");
  sync.attachDocument(doc);
  doc.set("k", "v");
  const op = doc.getOps().pop();
  await sync.broadcastOp(doc.id, op);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].docId, doc.id);
  assert.equal(sent[0].op.kind, "lww_set");
});

test("syncManager: handleRemoteOp applies to attached doc", () => {
  let updates = 0;
  const sync = createSyncManager({
    onRemoteUpdate: () => {
      updates += 1;
    },
  });
  const doc = createCRDTDocument("doc-sync-2");
  sync.attachDocument(doc);
  const remoteOp = {
    kind: "lww_set",
    field: "title",
    value: "remote",
    clock: { physical: Date.now() + 1000, logical: 0, node: "remote" },
  };
  const ok = sync.handleRemoteOp({ docId: doc.id, op: remoteOp });
  assert.equal(ok, true);
  assert.equal(updates, 1);
  assert.equal(doc.get("title"), "remote");
});

test("syncManager: pending ops survive broadcast failure", async () => {
  const sync = createSyncManager({
    broadcast: () => {
      throw new Error("transport down");
    },
  });
  const doc = createCRDTDocument("doc-sync-3");
  sync.attachDocument(doc);
  doc.set("k", 1);
  const op = doc.getOps().pop();
  await assert.rejects(() => sync.broadcastOp(doc.id, op));
  const pending = sync.getPendingOps(doc.id);
  assert.equal(pending.length, 1);
});

test("syncManager: fullSync converges two divergent docs", () => {
  const sync = createSyncManager({});
  const local = createCRDTDocument("doc-sync-4", { nodeId: "L" });
  const peer = createCRDTDocument("doc-sync-4", { nodeId: "R" });
  sync.attachDocument(local);
  local.set("a", 1);
  peer.set("b", 2);
  const snap = sync.fullSync(local.id, peer);
  assert.ok(snap);
  assert.equal(local.get("a"), 1);
  assert.equal(local.get("b"), 2);
});
