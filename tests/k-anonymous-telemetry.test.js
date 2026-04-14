/**
 * Phase 72.4: k-anonymous telemetry tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-ktel-"));
process.env.STORAGE_PATH = TMP;

const {
  recordEvent,
  aggregate,
  setKThreshold,
  getKThreshold,
  listBuckets,
  _reset,
} = await import("../lib/k-anonymous-telemetry.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("default k threshold is 5", async () => {
  await _reset();
  assert.equal(await getKThreshold(), 5);
});

test("setKThreshold persists a custom k", async () => {
  await _reset();
  await setKThreshold(3);
  assert.equal(await getKThreshold(), 3);
});

test("recordEvent creates a bucket scoped by dimensions", async () => {
  await _reset();
  await setKThreshold(2);
  await recordEvent({ eventName: "login", dimensions: { region: "us" }, userId: "u1" });
  const buckets = await listBuckets("login");
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].count, 1);
  assert.equal(buckets[0].uniqueUsers, 1);
});

test("recordEvent dedupes same user within bucket", async () => {
  await _reset();
  await recordEvent({ eventName: "click", dimensions: { p: "a" }, userId: "u1" });
  await recordEvent({ eventName: "click", dimensions: { p: "a" }, userId: "u1" });
  const buckets = await listBuckets("click");
  assert.equal(buckets[0].count, 2);
  assert.equal(buckets[0].uniqueUsers, 1);
});

test("recordEvent throws on missing params", async () => {
  await _reset();
  await assert.rejects(() => recordEvent({}), /eventName is required/);
  await assert.rejects(() => recordEvent({ eventName: "x" }), /userId is required/);
});

test("aggregate suppresses buckets below k threshold", async () => {
  await _reset();
  await setKThreshold(3);
  // Bucket A: 4 unique users → should be emitted
  for (const u of ["a", "b", "c", "d"]) {
    await recordEvent({ eventName: "visit", dimensions: { page: "home" }, userId: u });
  }
  // Bucket B: 2 unique users → should be suppressed
  for (const u of ["a", "b"]) {
    await recordEvent({ eventName: "visit", dimensions: { page: "about" }, userId: u });
  }
  const agg = await aggregate({ eventName: "visit" });
  assert.equal(agg.buckets.length, 1);
  assert.equal(agg.buckets[0].dimensions.page, "home");
  assert.equal(agg.totalSuppressed, 1);
});

test("aggregate applies dimension filter before k check", async () => {
  await _reset();
  await setKThreshold(2);
  for (const u of ["a", "b", "c"]) {
    await recordEvent({ eventName: "ev", dimensions: { region: "us" }, userId: u });
  }
  for (const u of ["d", "e"]) {
    await recordEvent({ eventName: "ev", dimensions: { region: "eu" }, userId: u });
  }
  const only = await aggregate({ eventName: "ev", dimensions: { region: "us" } });
  assert.equal(only.buckets.length, 1);
  assert.equal(only.buckets[0].dimensions.region, "us");
});

test("aggregate respects a per-call k override", async () => {
  await _reset();
  await setKThreshold(2);
  for (const u of ["a", "b"]) {
    await recordEvent({ eventName: "ovr", dimensions: { x: "1" }, userId: u });
  }
  const small = await aggregate({ eventName: "ovr", k: 2 });
  assert.equal(small.buckets.length, 1);
  const big = await aggregate({ eventName: "ovr", k: 5 });
  assert.equal(big.buckets.length, 0);
});

test("setKThreshold clamps to minimum 1", async () => {
  await _reset();
  await setKThreshold(0);
  assert.equal(await getKThreshold(), 1);
});
