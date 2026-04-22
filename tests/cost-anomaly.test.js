import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "cost-anom-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  anomalyDetectionEnabled,
  computeStats,
  groupByDay,
  detectAnomaly,
  checkAndNotifyAnomaly,
} = await import("../lib/cost-anomaly.js");
const { recordUsage } = await import("../lib/usage-tracker.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("anomalyDetectionEnabled: off by default", () => {
  const prev = process.env.COST_ANOMALY_DETECT;
  delete process.env.COST_ANOMALY_DETECT;
  try { assert.equal(anomalyDetectionEnabled(), false); }
  finally { if (prev !== undefined) process.env.COST_ANOMALY_DETECT = prev; }
});

test("computeStats: handles empty and single values", () => {
  assert.deepEqual(computeStats([]), { mean: 0, stddev: 0 });
  assert.deepEqual(computeStats([5]), { mean: 5, stddev: 0 });
});

test("computeStats: basic mean/stddev", () => {
  const { mean, stddev } = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(mean, 5);
  assert.ok(stddev > 1.8 && stddev < 2.4);
});

test("groupByDay: sums tokens by YYYY-MM-DD", () => {
  const r = groupByDay([
    { timestamp: "2026-04-22T10:00:00Z", inputTokens: 10, outputTokens: 5 },
    { timestamp: "2026-04-22T20:00:00Z", inputTokens: 3, outputTokens: 2 },
    { timestamp: "2026-04-21T10:00:00Z", inputTokens: 1, outputTokens: 1 },
  ]);
  assert.equal(r["2026-04-22"], 20);
  assert.equal(r["2026-04-21"], 2);
});

test("detectAnomaly: insufficient samples returns non-anomalous", async () => {
  const r = await detectAnomaly({ userId: "u-none", workspace: "anom-ws-0", minSamples: 20 });
  assert.equal(r.anomalous, false);
  assert.equal(r.reason, "insufficient_samples");
});

test("detectAnomaly: flags today when way above baseline", async () => {
  const userId = "u-spike";
  const workspace = "anom-ws-spike";
  // Seed 10 days of 100 tokens, then record 10000 today.
  const now = Date.now();
  for (let i = 1; i <= 10; i++) {
    const d = new Date(now - i * 86400_000);
    await recordUsage({
      timestamp: d.toISOString(),
      model: "m",
      inputTokens: 50,
      outputTokens: 50,
      backend: "b",
      userId,
      workspace,
    });
  }
  // Today record
  await recordUsage({
    timestamp: new Date().toISOString(),
    model: "m",
    inputTokens: 9000,
    outputTokens: 1000,
    backend: "b",
    userId,
    workspace,
  });
  const r = await detectAnomaly({ userId, workspace, sigma: 2, minSamples: 5 });
  assert.equal(r.anomalous, true);
  assert.ok(r.today >= 10000);
  assert.ok(r.threshold < r.today);
});

test("checkAndNotifyAnomaly: skipped when flag off", async () => {
  const prev = process.env.COST_ANOMALY_DETECT;
  delete process.env.COST_ANOMALY_DETECT;
  try {
    const r = await checkAndNotifyAnomaly({ userId: "x", workspace: "y" });
    assert.equal(r.skipped, true);
  } finally {
    if (prev !== undefined) process.env.COST_ANOMALY_DETECT = prev;
  }
});
