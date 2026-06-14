/**
 * Tests for lib/operational-transform.js and lib/ot-server.js — verifies
 * application, transformation, composition, inversion, and convergence
 * properties of the OT engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  OP_TYPES,
  createInsertOp,
  createDeleteOp,
  applyOp,
  transformOp,
  transformOps,
  composeOps,
  invertOp,
} from "../lib/operational-transform.js";
import { createOTServer } from "../lib/ot-server.js";

// ---- applyOp ----

test("applyOp inserts text at the requested position", () => {
  const op = createInsertOp(5, " world", "a");
  assert.equal(applyOp("hello", op), "hello world");
});

test("applyOp inserts at start and end", () => {
  assert.equal(applyOp("abc", createInsertOp(0, "X", "a")), "Xabc");
  assert.equal(applyOp("abc", createInsertOp(3, "X", "a")), "abcX");
});

test("applyOp deletes a range", () => {
  assert.equal(applyOp("hello world", createDeleteOp(5, 6, "a")), "hello");
});

test("applyOp clamps out-of-bounds insert positions", () => {
  assert.equal(applyOp("abc", createInsertOp(99, "Z", "a")), "abcZ");
  assert.equal(applyOp("abc", createInsertOp(-5, "Z", "a")), "Zabc");
});

test("applyOp clamps out-of-bounds delete ranges", () => {
  assert.equal(applyOp("abc", createDeleteOp(1, 100, "a")), "a");
  // Negative position clamps to 0 then deletes the requested length.
  assert.equal(applyOp("abc", createDeleteOp(-1, 2, "a")), "c");
});

// ---- transformOp: insert vs insert ----

test("transformOp insert-insert: op2 before op1 shifts op1 right", () => {
  const op1 = createInsertOp(5, "X", "a");
  const op2 = createInsertOp(2, "YY", "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 7);
});

test("transformOp insert-insert: op2 after op1 leaves op1 unchanged", () => {
  const op1 = createInsertOp(2, "X", "a");
  const op2 = createInsertOp(5, "YY", "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 2);
});

test("transformOp insert-insert at same position uses clientId tie-break", () => {
  const op1 = createInsertOp(3, "B", "client-b");
  const op2 = createInsertOp(3, "A", "client-a");
  // op2 is "smaller" client id, so it stays first; op1 shifts past it.
  const t = transformOp(op1, op2);
  assert.equal(t.position, 4);
});

// ---- transformOp: insert vs delete ----

test("transformOp insert vs delete before insert shifts insert left", () => {
  const op1 = createInsertOp(10, "X", "a");
  const op2 = createDeleteOp(2, 3, "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 7);
});

test("transformOp insert vs delete after insert leaves it unchanged", () => {
  const op1 = createInsertOp(2, "X", "a");
  const op2 = createDeleteOp(5, 3, "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 2);
});

test("transformOp insert inside deleted range collapses to deletion start", () => {
  const op1 = createInsertOp(5, "X", "a");
  const op2 = createDeleteOp(3, 5, "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 3);
});

// ---- transformOp: delete vs insert ----

test("transformOp delete vs insert before delete shifts delete right", () => {
  const op1 = createDeleteOp(5, 3, "a");
  const op2 = createInsertOp(2, "YY", "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 7);
  assert.equal(t.length, 3);
});

test("transformOp delete vs insert inside delete extends delete length", () => {
  const op1 = createDeleteOp(2, 5, "a"); // delete 2..7
  const op2 = createInsertOp(4, "ZZ", "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 2);
  assert.equal(t.length, 7);
});

// ---- transformOp: delete vs delete ----

test("transformOp delete vs disjoint earlier delete shifts left", () => {
  const op1 = createDeleteOp(10, 3, "a");
  const op2 = createDeleteOp(2, 4, "b");
  const t = transformOp(op1, op2);
  assert.equal(t.position, 6);
  assert.equal(t.length, 3);
});

test("transformOp delete vs identical delete cancels out", () => {
  const op1 = createDeleteOp(5, 4, "a");
  const op2 = createDeleteOp(5, 4, "b");
  const t = transformOp(op1, op2);
  assert.equal(t.type, OP_TYPES.RETAIN);
});

test("transformOp delete vs overlapping delete shrinks remaining range", () => {
  const op1 = createDeleteOp(5, 6, "a"); // 5..11
  const op2 = createDeleteOp(7, 2, "b"); // 7..9, fully inside op1
  const t = transformOp(op1, op2);
  assert.equal(t.length, 4);
});

// ---- transformOps batch ----

test("transformOps batch transforms each local op against an evolving remote op", () => {
  const local = [createInsertOp(5, "A", "a"), createInsertOp(6, "B", "a")];
  const remote = createInsertOp(2, "ZZ", "b");
  const { localOps, remoteOp } = transformOps(local, remote);
  assert.equal(localOps[0].position, 7);
  assert.equal(localOps[1].position, 8);
  // Remote got transformed against the local inserts: shifted by 2 (one from each).
  assert.equal(remoteOp.position, 2);
});

// ---- convergence: TP1 property for OT ----

test("convergence: insert vs insert from two peers yields the same final text", () => {
  const base = "the quick fox";
  const a = createInsertOp(4, "very ", "alice");
  const b = createInsertOp(10, "brown ", "bob");
  // Alice applies a then bob's transformed op:
  const aFirst = applyOp(applyOp(base, a), transformOp(b, a));
  // Bob applies b then alice's transformed op:
  const bFirst = applyOp(applyOp(base, b), transformOp(a, b));
  assert.equal(aFirst, bFirst);
});

test("convergence: insert vs delete from two peers yields the same final text", () => {
  const base = "abcdefghij";
  const a = createInsertOp(5, "XX", "alice");
  const b = createDeleteOp(2, 3, "bob");
  const aFirst = applyOp(applyOp(base, a), transformOp(b, a));
  const bFirst = applyOp(applyOp(base, b), transformOp(a, b));
  assert.equal(aFirst, bFirst);
});

test("convergence: delete vs delete from two peers yields the same final text", () => {
  const base = "abcdefghij";
  const a = createDeleteOp(2, 4, "alice"); // deletes "cdef"
  const b = createDeleteOp(4, 3, "bob"); // deletes "efg"
  const aFirst = applyOp(applyOp(base, a), transformOp(b, a));
  const bFirst = applyOp(applyOp(base, b), transformOp(a, b));
  assert.equal(aFirst, bFirst);
});

test("convergence: same-position concurrent inserts converge with tie-break", () => {
  const base = "ace";
  const a = createInsertOp(1, "B", "alice");
  const b = createInsertOp(1, "X", "bob");
  const aFirst = applyOp(applyOp(base, a), transformOp(b, a));
  const bFirst = applyOp(applyOp(base, b), transformOp(a, b));
  assert.equal(aFirst, bFirst);
});

// ---- composeOps ----

test("composeOps merges adjacent inserts from same client", () => {
  const o1 = createInsertOp(2, "AB", "a");
  const o2 = createInsertOp(4, "CD", "a");
  const result = composeOps(o1, o2);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, "ABCD");
  assert.equal(result[0].position, 2);
});

test("composeOps merges adjacent deletes from same client", () => {
  const o1 = createDeleteOp(2, 3, "a");
  const o2 = createDeleteOp(2, 4, "a");
  const result = composeOps(o1, o2);
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 7);
});

test("composeOps cancels insert immediately undone by delete", () => {
  const o1 = createInsertOp(2, "XYZ", "a");
  const o2 = createDeleteOp(2, 3, "a");
  const result = composeOps(o1, o2);
  assert.equal(result.length, 0);
});

test("composeOps keeps unrelated ops separate", () => {
  const o1 = createInsertOp(2, "X", "a");
  const o2 = createDeleteOp(10, 1, "a");
  const result = composeOps(o1, o2);
  assert.equal(result.length, 2);
});

// ---- invertOp ----

test("invertOp insert produces a delete that undoes it", () => {
  const text = "hello";
  const op = createInsertOp(5, " world", "a");
  const after = applyOp(text, op);
  const inv = invertOp(op, text);
  assert.equal(applyOp(after, inv), text);
});

test("invertOp delete produces an insert that restores deleted text", () => {
  const text = "hello world";
  const op = createDeleteOp(5, 6, "a");
  const after = applyOp(text, op);
  const inv = invertOp(op, text);
  assert.equal(applyOp(after, inv), text);
});

test("invertOp roundtrip on chained edits", () => {
  let text = "the cat sat";
  const op1 = createInsertOp(8, "down ", "a");
  const inv1 = invertOp(op1, text);
  text = applyOp(text, op1);
  assert.equal(text, "the cat down sat");
  text = applyOp(text, inv1);
  assert.equal(text, "the cat sat");
});

// ---- OT server ----

test("ot-server: createDocument and getDocument", () => {
  const server = createOTServer();
  const doc = server.createDocument("doc-1", "hello");
  assert.equal(doc.text, "hello");
  assert.equal(doc.version, 0);
  assert.equal(server.getDocument("doc-1"), doc);
});

test("ot-server: applyClientOp bumps version and applies op", () => {
  const server = createOTServer();
  server.createDocument("doc-1", "hello");
  const result = server.applyClientOp("doc-1", createInsertOp(5, " world", "a"), 0);
  assert.equal(result.version, 1);
  assert.equal(result.text, "hello world");
});

test("ot-server: applyClientOp transforms against intervening ops", () => {
  const server = createOTServer();
  server.createDocument("doc-1", "abcdef");
  // Alice (base 0) inserts "X" at 0; server applies it -> version 1.
  server.applyClientOp("doc-1", createInsertOp(0, "X", "alice"), 0);
  // Bob also based on version 0, inserts "Y" at 3. Server should transform
  // his op forward by alice's insert -> position 4 in the new doc.
  const result = server.applyClientOp("doc-1", createInsertOp(3, "Y", "bob"), 0);
  assert.equal(result.version, 2);
  assert.equal(result.text, "XabcYdef");
  assert.equal(result.op.position, 4);
});

test("ot-server: getOpsSince returns ops after the given version", () => {
  const server = createOTServer();
  server.createDocument("doc-1", "");
  server.applyClientOp("doc-1", createInsertOp(0, "a", "x"), 0);
  server.applyClientOp("doc-1", createInsertOp(1, "b", "x"), 1);
  server.applyClientOp("doc-1", createInsertOp(2, "c", "x"), 2);
  const ops = server.getOpsSince("doc-1", 1);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].version, 2);
  assert.equal(ops[1].version, 3);
});

test("ot-server: end-to-end three-peer convergence", () => {
  const server = createOTServer();
  server.createDocument("d", "ABCDE");
  // Alice deletes "B" at 1, base 0
  const r1 = server.applyClientOp("d", createDeleteOp(1, 1, "alice"), 0);
  // Bob inserts "Z" at 4, also base 0 (concurrent with alice)
  const r2 = server.applyClientOp("d", createInsertOp(4, "Z", "bob"), 0);
  // Carol inserts "Q" at 5, also base 0 (concurrent with both)
  const r3 = server.applyClientOp("d", createInsertOp(5, "Q", "carol"), 0);

  assert.equal(r1.text, "ACDE");
  // Bob's insert at 4 is past alice's delete at 1, so position shifts to 3.
  assert.equal(r2.op.position, 3);
  // Carol's insert at 5: shift left by alice's delete (1) to 4, then right by
  // bob's insert at 3 (1) to 5. Final text length is 6.
  assert.equal(r3.text.length, 6);
  // Final document is consistent regardless of order.
  const finalText = server.getDocument("d").text;
  assert.ok(finalText.includes("Z"));
  assert.ok(finalText.includes("Q"));
  assert.ok(!finalText.includes("B"));
});

test("ot-server: rejects unsupported op type", () => {
  const server = createOTServer();
  server.createDocument("d", "");
  assert.throws(() => server.applyClientOp("d", { type: "bogus" }, 0));
});

test("ot-server: rejects unknown document", () => {
  const server = createOTServer();
  assert.throws(() => server.applyClientOp("nope", createInsertOp(0, "a", "x"), 0));
});

// ---- multi-op convergence (transformOps batch) ----

test("multi-op transform batch keeps both peers in sync", () => {
  const base = "12345";
  // Alice: insert "A" at 2, then insert "B" at 3
  const aOps = [createInsertOp(2, "A", "alice"), createInsertOp(3, "B", "alice")];
  // Bob: insert "X" at 4 (concurrent with alice's batch)
  const bOp = createInsertOp(4, "X", "bob");

  // Alice applies her ops locally, then receives bob's (transformed against her batch).
  let aliceText = base;
  for (const op of aOps) aliceText = applyOp(aliceText, op);
  const { remoteOp: bobForAlice } = transformOps(aOps, bOp);
  aliceText = applyOp(aliceText, bobForAlice);

  // Bob applies his op locally, then receives alice's batch (each transformed against bob).
  let bobText = applyOp(base, bOp);
  let evolvingBob = bOp;
  for (const localOp of aOps) {
    const t = transformOp(localOp, evolvingBob);
    evolvingBob = transformOp(evolvingBob, localOp);
    bobText = applyOp(bobText, t);
  }

  assert.equal(aliceText, bobText);
});
