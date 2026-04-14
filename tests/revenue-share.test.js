/**
 * Phase 71.3: Revenue share tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-revenue-share-"));
process.env.STORAGE_PATH = TMP;

const {
  registerAuthor,
  listAuthors,
  getAuthor,
  setShareRate,
  recordUsage,
  computePayout,
  recordPayout,
  listPayouts,
  AUTHOR_USAGE_TYPES,
  _reset,
} = await import("../lib/revenue-share.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("AUTHOR_USAGE_TYPES includes plugin, recipe, template, other", () => {
  for (const t of ["plugin", "recipe", "template", "other"]) {
    assert.ok(AUTHOR_USAGE_TYPES.includes(t), `missing ${t}`);
  }
});

test("registerAuthor stores author and clamps rate to [0,1]", async () => {
  await _reset();
  const a = await registerAuthor({
    authorId: "acme",
    name: "Acme Corp",
    payoutMethod: "stripe",
    defaultRate: 0.8,
  });
  assert.equal(a.authorId, "acme");
  assert.equal(a.rate, 0.8);
  const b = await registerAuthor({
    authorId: "too-high", name: "X", payoutMethod: "stripe", defaultRate: 5,
  });
  assert.equal(b.rate, 1);
  const c = await registerAuthor({
    authorId: "neg", name: "X", payoutMethod: "stripe", defaultRate: -0.5,
  });
  assert.equal(c.rate, 0);
});

test("registerAuthor rejects missing fields", async () => {
  await _reset();
  await assert.rejects(() => registerAuthor({ name: "x", payoutMethod: "p" }), /authorId/);
  await assert.rejects(() => registerAuthor({ authorId: "a", payoutMethod: "p" }), /name/);
  await assert.rejects(() => registerAuthor({ authorId: "a", name: "x" }), /payoutMethod/);
});

test("listAuthors and getAuthor", async () => {
  await _reset();
  await registerAuthor({ authorId: "a1", name: "A1", payoutMethod: "stripe" });
  await registerAuthor({ authorId: "a2", name: "A2", payoutMethod: "paypal" });
  const all = await listAuthors();
  assert.equal(all.length, 2);
  const a1 = await getAuthor("a1");
  assert.equal(a1.name, "A1");
  assert.equal(await getAuthor("nope"), null);
});

test("setShareRate updates the author's rate", async () => {
  await _reset();
  await registerAuthor({ authorId: "a", name: "A", payoutMethod: "stripe", defaultRate: 0.5 });
  const updated = await setShareRate({ authorId: "a", rate: 0.9 });
  assert.equal(updated.rate, 0.9);
  await assert.rejects(() => setShareRate({ authorId: "a", rate: "bad" }), /rate/);
  await assert.rejects(() => setShareRate({ authorId: "nope", rate: 0.5 }), /not found/);
});

test("recordUsage validates type and author", async () => {
  await _reset();
  await registerAuthor({ authorId: "a", name: "A", payoutMethod: "stripe" });
  await assert.rejects(
    () => recordUsage({ authorId: "a", type: "nope", units: 1, grossAmount: 1 }),
    /type must be one of/,
  );
  await assert.rejects(
    () => recordUsage({ authorId: "missing", type: "plugin", units: 1, grossAmount: 1 }),
    /not found/,
  );
  await assert.rejects(
    () => recordUsage({ authorId: "a", type: "plugin", units: -1, grossAmount: 1 }),
    /units/,
  );
});

test("recordUsage stores events and computePayout sums by period", async () => {
  await _reset();
  await registerAuthor({ authorId: "acme", name: "Acme", payoutMethod: "stripe", defaultRate: 0.5 });
  await recordUsage({ authorId: "acme", type: "plugin", units: 10, grossAmount: 100, timestamp: 1000 });
  await recordUsage({ authorId: "acme", type: "recipe", units: 5, grossAmount: 50, timestamp: 2000 });
  await recordUsage({ authorId: "acme", type: "template", units: 2, grossAmount: 20, timestamp: 5000 });

  const full = await computePayout({ authorId: "acme", period: { start: 0, end: 10000 } });
  assert.equal(full.totalGross, 170);
  assert.equal(full.totalShare, 85); // 0.5 * 170
  assert.equal(full.usageCount, 3);
  assert.equal(full.rate, 0.5);

  const mid = await computePayout({ authorId: "acme", period: { start: 1500, end: 3000 } });
  assert.equal(mid.totalGross, 50);
  assert.equal(mid.totalShare, 25);
  assert.equal(mid.usageCount, 1);
});

test("computePayout rejects invalid period", async () => {
  await _reset();
  await registerAuthor({ authorId: "a", name: "A", payoutMethod: "stripe" });
  await assert.rejects(
    () => computePayout({ authorId: "a", period: { start: 500, end: 100 } }),
    /period/,
  );
  await assert.rejects(
    () => computePayout({ authorId: "missing", period: { start: 0, end: 1 } }),
    /not found/,
  );
});

test("recordPayout appends to ledger, listPayouts returns all", async () => {
  await _reset();
  await registerAuthor({ authorId: "acme", name: "Acme", payoutMethod: "stripe" });
  const p1 = await recordPayout({ authorId: "acme", period: { start: 0, end: 1000 }, amount: 12.34, reference: "stripe-1" });
  assert.ok(p1.payoutId);
  assert.equal(p1.amount, 12.34);
  await recordPayout({ authorId: "acme", period: { start: 1000, end: 2000 }, amount: 7.5, reference: "stripe-2" });
  const payouts = await listPayouts("acme");
  assert.equal(payouts.length, 2);
  // Sorted newest first
  assert.ok(payouts[0].timestamp >= payouts[1].timestamp);
});

test("recordPayout rejects unknown author and bad amount", async () => {
  await _reset();
  await assert.rejects(
    () => recordPayout({ authorId: "nope", amount: 10 }),
    /not found/,
  );
  await registerAuthor({ authorId: "a", name: "A", payoutMethod: "x" });
  await assert.rejects(
    () => recordPayout({ authorId: "a", amount: -5 }),
    /amount/,
  );
});
