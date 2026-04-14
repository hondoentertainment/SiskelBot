/**
 * Phase 71.4: Credit system tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-credit-system-"));
process.env.STORAGE_PATH = TMP;

const {
  addCredits,
  consumeCredits,
  refundCredits,
  getBalance,
  listTransactions,
  TRANSACTION_TYPES,
  _reset,
} = await import("../lib/credit-system.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("TRANSACTION_TYPES includes add/consume/refund", () => {
  for (const t of ["add", "consume", "refund"]) {
    assert.ok(TRANSACTION_TYPES.includes(t), `missing ${t}`);
  }
});

test("addCredits increases balance; getBalance reports the new amount", async () => {
  await _reset();
  const before = await getBalance("u1");
  assert.equal(before.balance, 0);
  const rec = await addCredits({ userId: "u1", amount: 25.5, source: "stripe", reference: "ch_1" });
  assert.equal(rec.type, "add");
  assert.equal(rec.balanceAfter, 25.5);
  assert.equal(rec.source, "stripe");
  const after = await getBalance("u1");
  assert.equal(after.balance, 25.5);
});

test("addCredits rejects non-positive and missing fields", async () => {
  await _reset();
  await assert.rejects(() => addCredits({ amount: 1, source: "x" }), /userId/);
  await assert.rejects(() => addCredits({ userId: "u", amount: 1 }), /source/);
  await assert.rejects(() => addCredits({ userId: "u", amount: 0, source: "x" }), /positive/);
});

test("consumeCredits reduces balance and rejects when insufficient", async () => {
  await _reset();
  await addCredits({ userId: "u2", amount: 10, source: "promo" });
  const rec = await consumeCredits({ userId: "u2", amount: 3, reason: "api call" });
  assert.equal(rec.type, "consume");
  assert.equal(rec.balanceAfter, 7);
  const bal = await getBalance("u2");
  assert.equal(bal.balance, 7);
  await assert.rejects(
    () => consumeCredits({ userId: "u2", amount: 100, reason: "too big" }),
    /insufficient/,
  );
});

test("refundCredits reverses a consume, balance returns to pre-consume", async () => {
  await _reset();
  await addCredits({ userId: "u3", amount: 20, source: "promo" });
  const consume = await consumeCredits({ userId: "u3", amount: 7.25, reason: "work" });
  assert.equal((await getBalance("u3")).balance, 12.75);
  const refund = await refundCredits({ userId: "u3", transactionId: consume.txId });
  assert.equal(refund.type, "refund");
  assert.equal(refund.amount, 7.25);
  assert.equal((await getBalance("u3")).balance, 20);
});

test("refundCredits rejects double refund or bad id", async () => {
  await _reset();
  await addCredits({ userId: "u4", amount: 10, source: "promo" });
  const c = await consumeCredits({ userId: "u4", amount: 5, reason: "x" });
  await refundCredits({ userId: "u4", transactionId: c.txId });
  await assert.rejects(
    () => refundCredits({ userId: "u4", transactionId: c.txId }),
    /already refunded/,
  );
  await assert.rejects(
    () => refundCredits({ userId: "u4", transactionId: "nope" }),
    /not found/,
  );
});

test("refundCredits rejects non-consume transactions", async () => {
  await _reset();
  const add = await addCredits({ userId: "u5", amount: 10, source: "promo" });
  await assert.rejects(
    () => refundCredits({ userId: "u5", transactionId: add.txId }),
    /only consume/,
  );
});

test("listTransactions returns in newest-first order with pagination", async () => {
  await _reset();
  await addCredits({ userId: "u6", amount: 100, source: "seed" });
  for (let i = 0; i < 5; i += 1) {
    await consumeCredits({ userId: "u6", amount: 1, reason: `r${i}` });
  }
  const all = await listTransactions({ userId: "u6" });
  assert.equal(all.total, 6);
  assert.equal(all.transactions.length, 6);
  assert.ok(all.transactions[0].timestamp >= all.transactions[1].timestamp);
  const page = await listTransactions({ userId: "u6", limit: 2, offset: 1 });
  assert.equal(page.transactions.length, 2);
  assert.equal(page.offset, 1);
});

test("listTransactions filters by type", async () => {
  await _reset();
  await addCredits({ userId: "u7", amount: 10, source: "s" });
  await consumeCredits({ userId: "u7", amount: 2, reason: "r" });
  await consumeCredits({ userId: "u7", amount: 3, reason: "r" });
  const adds = await listTransactions({ userId: "u7", type: "add" });
  assert.equal(adds.total, 1);
  const consumes = await listTransactions({ userId: "u7", type: "consume" });
  assert.equal(consumes.total, 2);
});

test("balance uses integer cents, no floating point drift", async () => {
  await _reset();
  // 0.1 + 0.2 notoriously != 0.3 in floats.
  await addCredits({ userId: "u8", amount: 0.1, source: "x" });
  await addCredits({ userId: "u8", amount: 0.2, source: "x" });
  const b = await getBalance("u8");
  assert.equal(b.balance, 0.3);
  assert.equal(b.balanceCents, 30);
});

test("consumeCredits fails with 'insufficient' when balance exactly exceeded", async () => {
  await _reset();
  await addCredits({ userId: "u9", amount: 5, source: "x" });
  await consumeCredits({ userId: "u9", amount: 5, reason: "ok" });
  await assert.rejects(
    () => consumeCredits({ userId: "u9", amount: 0.01, reason: "now empty" }),
    /insufficient/,
  );
  const b = await getBalance("u9");
  assert.equal(b.balance, 0);
});
