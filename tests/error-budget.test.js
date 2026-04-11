/**
 * Phase 59.5: Error budget tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-err-budget-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  defineSlo,
  recordEvent,
  getBudgetRemaining,
  isBudgetExhausted,
  listSlos,
} = await import("../lib/error-budget.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// Injectable clock so tests don't rely on wall-clock drift.
let fakeNow = 1_700_000_000_000;
const clock = () => fakeNow;

test("defineSlo persists with defaults", async () => {
  const slo = await defineSlo({
    id: "chat-completions",
    name: "chat completions availability",
    target: 0.99,
    windowSeconds: 3600,
  });
  assert.equal(slo.id, "chat-completions");
  assert.equal(slo.target, 0.99);
  assert.equal(slo.windowSeconds, 3600);
  assert.equal(slo.minSample, 100);
  assert.deepEqual(slo.events, []);
});

test("defineSlo rejects invalid input", async () => {
  await assert.rejects(() => defineSlo(null));
  await assert.rejects(() => defineSlo({ id: "x", name: "n", target: 1.1, windowSeconds: 60 }));
  await assert.rejects(() => defineSlo({ id: "x", name: "n", target: 0.5, windowSeconds: -1 }));
  await assert.rejects(() => defineSlo({ name: "n", target: 0.5, windowSeconds: 60 }));
});

test("recordEvent appends events within the window", async () => {
  await defineSlo({
    id: "event-test",
    name: "event test",
    target: 0.95,
    windowSeconds: 60,
    minSample: 1,
  });
  fakeNow = 1_700_000_000_000;
  const slo = await recordEvent("event-test", true, { clock });
  assert.equal(slo.events.length, 1);
  assert.equal(slo.events[0].success, true);
  await recordEvent("event-test", false, { clock });
  await recordEvent("event-test", true, { clock });
  const budget = await getBudgetRemaining("event-test", { clock });
  assert.equal(budget.total, 3);
  assert.equal(budget.failures, 1);
});

test("recordEvent rejects unknown slo id", async () => {
  await assert.rejects(() => recordEvent("none", true));
  await assert.rejects(() => recordEvent("", true));
});

test("recordEvent prunes events outside the window", async () => {
  await defineSlo({
    id: "prune-test",
    name: "prune",
    target: 0.9,
    windowSeconds: 10,
    minSample: 1,
  });
  fakeNow = 2_000_000_000_000;
  await recordEvent("prune-test", true, { clock });
  // Fast-forward 1 hour; next event should purge old ones.
  fakeNow += 3_600_000;
  const slo = await recordEvent("prune-test", true, { clock });
  assert.equal(slo.events.length, 1);
});

test("getBudgetRemaining computes allowed failures correctly", async () => {
  await defineSlo({
    id: "budget-math",
    name: "math",
    target: 0.9, // allow 10% failures
    windowSeconds: 600,
    minSample: 1,
  });
  fakeNow = 3_000_000_000_000;
  for (let i = 0; i < 10; i += 1) {
    await recordEvent("budget-math", i !== 0, { clock }); // 1 failure
  }
  const b = await getBudgetRemaining("budget-math", { clock });
  assert.equal(b.total, 10);
  assert.equal(b.failures, 1);
  // allowed = floor((1-0.9) * 10) = 1
  assert.equal(b.allowed, 1);
  assert.equal(b.remaining, 0);
});

test("getBudgetRemaining handles empty event stream", async () => {
  await defineSlo({
    id: "empty",
    name: "empty",
    target: 0.99,
    windowSeconds: 600,
  });
  const b = await getBudgetRemaining("empty");
  assert.equal(b.total, 0);
  assert.equal(b.successRate, 1);
});

test("isBudgetExhausted false until minSample reached", async () => {
  await defineSlo({
    id: "min-sample",
    name: "min",
    target: 0.9,
    windowSeconds: 600,
    minSample: 10,
  });
  fakeNow = 4_000_000_000_000;
  // Record 5 failures — fewer than minSample
  for (let i = 0; i < 5; i += 1) await recordEvent("min-sample", false, { clock });
  assert.equal(await isBudgetExhausted("min-sample", { clock }), false);
  for (let i = 0; i < 6; i += 1) await recordEvent("min-sample", false, { clock });
  assert.equal(await isBudgetExhausted("min-sample", { clock }), true);
});

test("isBudgetExhausted returns false for unknown slo", async () => {
  assert.equal(await isBudgetExhausted("none"), false);
});

test("listSlos includes per-slo budget snapshots", async () => {
  const slos = await listSlos();
  assert.ok(slos.length >= 4);
  for (const s of slos) {
    if (s.budget) {
      assert.equal(typeof s.budget.total, "number");
      assert.equal(typeof s.budget.remaining, "number");
    }
  }
});
