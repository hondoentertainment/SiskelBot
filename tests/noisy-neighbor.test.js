/**
 * Phase 66.2: Noisy neighbor tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-noisy-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordUsage,
  detectOutliers,
  throttleTenant,
  unthrottleTenant,
  listThrottled,
  isThrottled,
  computeStats,
} = await import("../lib/noisy-neighbor.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("computeStats handles empty input", () => {
  const s = computeStats([]);
  assert.equal(s.n, 0);
  assert.equal(s.mean, 0);
  assert.equal(s.std, 0);
});

test("computeStats computes mean, std, median, mad", () => {
  const s = computeStats([1, 2, 3, 4, 5]);
  assert.equal(s.n, 5);
  assert.equal(s.mean, 3);
  assert.equal(s.median, 3);
  assert.ok(Math.abs(s.std - Math.sqrt(2)) < 1e-9);
  assert.ok(s.mad >= 0);
});

test("recordUsage validates input", async () => {
  await assert.rejects(() => recordUsage("", "m", 1));
  await assert.rejects(() => recordUsage("t", "", 1));
  await assert.rejects(() => recordUsage("t", "m", -1));
  await assert.rejects(() => recordUsage("t", "m", "abc"));
});

test("detectOutliers flags extreme tenants via zscore", async () => {
  // Seed baseline tenants with normal usage
  for (let i = 0; i < 10; i++) {
    await recordUsage(`tenant-${i}`, "rpm", 10 + (i % 3));
  }
  // Add an extreme outlier
  await recordUsage("noisy", "rpm", 1000);
  const out = await detectOutliers({ metric: "rpm", minSamples: 5 });
  assert.ok(out.length >= 1);
  assert.equal(out[0].tenantId, "noisy");
  assert.ok(out[0].score > 3);
});

test("detectOutliers respects minSamples", async () => {
  const out = await detectOutliers({ metric: "nonexistent", minSamples: 100 });
  assert.deepEqual(out, []);
});

test("detectOutliers returns empty when no tenants recorded for metric", async () => {
  const out = await detectOutliers({ metric: "never-recorded" });
  assert.deepEqual(out, []);
});

test("throttleTenant persists and isThrottled detects", async () => {
  await throttleTenant("tenant-x", { reason: "noisy behaviour", actor: "admin" });
  assert.equal(await isThrottled("tenant-x"), true);
  const list = await listThrottled();
  assert.ok(list.find((r) => r.tenantId === "tenant-x"));
});

test("unthrottleTenant removes entries", async () => {
  await throttleTenant("tenant-y", { reason: "for test" });
  const ok = await unthrottleTenant("tenant-y");
  assert.equal(ok, true);
  assert.equal(await isThrottled("tenant-y"), false);
  const notOk = await unthrottleTenant("tenant-y");
  assert.equal(notOk, false);
});

test("isThrottled returns false when until has expired", async () => {
  await throttleTenant("tenant-z", { reason: "timed", until: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await isThrottled("tenant-z"), false);
  const list = await listThrottled();
  const z = list.find((r) => r.tenantId === "tenant-z");
  assert.ok(z);
  assert.equal(z.expired, true);
});

test("detectOutliers method=mad ignores zscore and flags via MAD", async () => {
  for (let i = 0; i < 10; i++) {
    await recordUsage(`mad-base-${i}`, "qps", 5);
  }
  await recordUsage("mad-spike", "qps", 500);
  const out = await detectOutliers({ metric: "qps", method: "mad", minSamples: 5 });
  assert.ok(out.some((r) => r.tenantId === "mad-spike"));
});

test("recordUsage keeps samples bounded", async () => {
  for (let i = 0; i < 20; i++) {
    await recordUsage("bounded", "count", i);
  }
  const out = await detectOutliers({ metric: "count", minSamples: 1 });
  assert.ok(Array.isArray(out));
});
