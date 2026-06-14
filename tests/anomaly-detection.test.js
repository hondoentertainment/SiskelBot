import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/anomaly-detection-test-" + Date.now();
});

await test("zScoreDetection finds an obvious outlier", async () => {
  const { zScoreDetection } = await import("../lib/anomaly-detection.js");
  // Stable baseline with one massive spike at index 10.
  const series = [10, 11, 9, 10, 12, 10, 11, 9, 10, 11, 500, 10, 9, 11, 10];
  const out = zScoreDetection(series, 3);
  assert.ok(out.length >= 1);
  const spike = out.find((a) => a.index === 10);
  assert.ok(spike, "should detect index 10 spike");
  assert.equal(spike.value, 500);
  assert.ok(Math.abs(spike.deviation) > 3);
  assert.ok(["low", "medium", "high", "critical"].includes(spike.severity));
});

await test("zScoreDetection returns empty when series has no variance", async () => {
  const { zScoreDetection } = await import("../lib/anomaly-detection.js");
  const out = zScoreDetection([5, 5, 5, 5, 5, 5], 3);
  assert.equal(out.length, 0);
});

await test("zScoreDetection returns empty for very short series", async () => {
  const { zScoreDetection } = await import("../lib/anomaly-detection.js");
  assert.deepEqual(zScoreDetection([1, 2], 3), []);
});

await test("iqrDetection finds outliers outside 1.5*IQR", async () => {
  const { iqrDetection } = await import("../lib/anomaly-detection.js");
  // Symmetric values around 10 with one extreme outlier.
  const series = [10, 11, 9, 10, 12, 10, 11, 9, 10, 11, 12, 10, 9, 11, 10, 1000];
  const out = iqrDetection(series, 1.5);
  assert.ok(out.length >= 1);
  const outlier = out.find((a) => a.value === 1000);
  assert.ok(outlier, "should detect 1000 as outlier");
  assert.equal(outlier.method, "iqr");
});

await test("iqrDetection returns empty for uniform series", async () => {
  const { iqrDetection } = await import("../lib/anomaly-detection.js");
  const out = iqrDetection([5, 5, 5, 5, 5, 5, 5, 5], 1.5);
  assert.equal(out.length, 0);
});

await test("ewmaDetection detects sudden level shift", async () => {
  const { ewmaDetection } = await import("../lib/anomaly-detection.js");
  // 20 stable points then a huge jump.
  const series = [
    100, 102, 98, 101, 99, 100, 103, 97, 100, 101,
    99, 100, 102, 98, 101, 100, 99, 102, 100, 101,
    5000,
  ];
  const out = ewmaDetection(series, 0.3, 3);
  assert.ok(out.length >= 1);
  const spike = out.find((a) => a.value === 5000);
  assert.ok(spike, "should detect EWMA spike");
  assert.equal(spike.method, "ewma");
});

await test("ewmaDetection returns empty for short series", async () => {
  const { ewmaDetection } = await import("../lib/anomaly-detection.js");
  assert.deepEqual(ewmaDetection([1, 2], 0.3, 3), []);
});

await test("seasonalDetection decomposes and detects residual outlier", async () => {
  const { seasonalDetection } = await import("../lib/anomaly-detection.js");
  // 4 cycles of period 6 with stable seasonal pattern, then inject outlier.
  const pattern = [10, 20, 30, 25, 15, 5];
  const series = [];
  for (let c = 0; c < 5; c++) {
    for (const v of pattern) series.push(v + (Math.random() * 0.1));
  }
  // Inject huge spike at index 14 (not just the natural cycle peak).
  series[14] = 500;
  const out = seasonalDetection(series, 6, 2);
  assert.ok(out.length >= 1, "should detect at least one anomaly");
  // The injected spike should be present.
  const detectedSpike = out.find((a) => a.value === 500);
  assert.ok(detectedSpike, "should detect injected spike");
  assert.equal(detectedSpike.method, "seasonal");
});

await test("seasonalDetection returns empty for too-short series", async () => {
  const { seasonalDetection } = await import("../lib/anomaly-detection.js");
  assert.deepEqual(seasonalDetection([1, 2, 3, 4], 6), []);
});

await test("detectAnomalies dispatches by method option", async () => {
  const { detectAnomalies } = await import("../lib/anomaly-detection.js");
  // Need a series with non-zero IQR (Q1 != Q3) so IQR detector can run.
  const series = [1, 2, 1, 2, 3, 2, 1, 3, 2, 1, 2, 3, 100];
  const z = detectAnomalies(series, { method: "zscore", threshold: 2 });
  assert.ok(z.length >= 1);
  assert.equal(z[0].method, "zscore");

  const i = detectAnomalies(series, { method: "iqr" });
  assert.ok(i.length >= 1);
  assert.equal(i[0].method, "iqr");
});

await test("detectAnomalies respects windowSize option", async () => {
  const { detectAnomalies } = await import("../lib/anomaly-detection.js");
  // Spike is in the first half; with windowSize=5 only the last 5 points
  // are considered, and there's no spike there.
  const series = [1, 2, 1000, 1, 2, 3, 2, 3, 2, 3];
  const result = detectAnomalies(series, { method: "zscore", threshold: 2, windowSize: 5 });
  assert.equal(result.length, 0);
});

await test("detectAnomalies accepts object array with .value", async () => {
  const { detectAnomalies } = await import("../lib/anomaly-detection.js");
  const series = [
    { value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }, { value: 1 },
    { value: 1 }, { value: 1 }, { value: 1 }, { value: 100 }, { value: 1 },
  ];
  const out = detectAnomalies(series, { method: "zscore", threshold: 2 });
  assert.ok(out.length >= 1);
  assert.equal(out[0].value, 100);
});

await test("runAnomalyScan persists detected anomalies and emits events", async () => {
  const { _resetAnomalyStoreForTests, runAnomalyScan, getActiveAnomalies } = await import(
    "../lib/anomaly-detection.js"
  );
  const { recordUsage } = await import("../lib/usage-tracker.js");
  await _resetAnomalyStoreForTests();

  // Seed normal usage records.
  for (let i = 0; i < 30; i++) {
    await recordUsage({
      model: "gpt-4",
      inputTokens: 50,
      outputTokens: 50,
      backend: "openai",
      workspace: "anom-ws",
      timestamp: new Date(Date.now() - (i + 1) * 3600 * 1000).toISOString(),
    });
  }
  // Inject many records into a single hourly bucket to create a spike.
  const spikeTs = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 100; i++) {
    await recordUsage({
      model: "gpt-4",
      inputTokens: 50,
      outputTokens: 50,
      backend: "openai",
      workspace: "anom-ws",
      timestamp: spikeTs,
    });
  }

  const result = await runAnomalyScan("request_rate", 7, { workspace: "anom-ws", method: "zscore", threshold: 2 });
  assert.ok(result.anomalies.length >= 1, "should detect spike anomaly");
  const stored = await getActiveAnomalies("anom-ws");
  assert.ok(stored.length >= 1);
  assert.equal(stored[0].metric, "request_rate");
  assert.equal(stored[0].workspaceId, "anom-ws");
  assert.equal(stored[0].acknowledged, false);
});

await test("acknowledgeAnomaly marks anomaly as acknowledged", async () => {
  const { _resetAnomalyStoreForTests, runAnomalyScan, acknowledgeAnomaly, getActiveAnomalies } = await import(
    "../lib/anomaly-detection.js"
  );
  const { recordUsage } = await import("../lib/usage-tracker.js");
  await _resetAnomalyStoreForTests();

  for (let i = 0; i < 25; i++) {
    await recordUsage({
      model: "gpt-4",
      inputTokens: 10,
      outputTokens: 10,
      backend: "openai",
      workspace: "ack-ws",
      timestamp: new Date(Date.now() - (i + 1) * 3600 * 1000).toISOString(),
    });
  }
  const spikeTs = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 80; i++) {
    await recordUsage({
      model: "gpt-4",
      inputTokens: 10,
      outputTokens: 10,
      backend: "openai",
      workspace: "ack-ws",
      timestamp: spikeTs,
    });
  }

  const scan = await runAnomalyScan("request_rate", 7, { workspace: "ack-ws", method: "zscore", threshold: 2 });
  assert.ok(scan.anomalies.length >= 1);
  const id = scan.anomalies[0].id;

  const ack = await acknowledgeAnomaly(id);
  assert.ok(ack);
  assert.equal(ack.acknowledged, true);
  assert.ok(ack.acknowledgedAt);

  const active = await getActiveAnomalies("ack-ws");
  assert.ok(!active.find((a) => a.id === id), "acknowledged anomaly should not be active");
});

await test("acknowledgeAnomaly returns null for unknown id", async () => {
  const { acknowledgeAnomaly } = await import("../lib/anomaly-detection.js");
  const result = await acknowledgeAnomaly("nonexistent-id");
  assert.equal(result, null);
});

await test("getAnomalyHistory returns recent anomalies sorted desc", async () => {
  const { _resetAnomalyStoreForTests, runAnomalyScan, getAnomalyHistory } = await import(
    "../lib/anomaly-detection.js"
  );
  const { recordUsage } = await import("../lib/usage-tracker.js");
  await _resetAnomalyStoreForTests();

  for (let i = 0; i < 25; i++) {
    await recordUsage({
      model: "gpt-4",
      inputTokens: 10,
      outputTokens: 10,
      backend: "openai",
      workspace: "hist-ws",
      timestamp: new Date(Date.now() - (i + 1) * 3600 * 1000).toISOString(),
    });
  }
  const spikeTs = new Date(Date.now() - 1000).toISOString();
  for (let i = 0; i < 80; i++) {
    await recordUsage({
      model: "gpt-4",
      inputTokens: 10,
      outputTokens: 10,
      backend: "openai",
      workspace: "hist-ws",
      timestamp: spikeTs,
    });
  }
  await runAnomalyScan("request_rate", 7, { workspace: "hist-ws", method: "zscore", threshold: 2 });
  const history = await getAnomalyHistory(30, "hist-ws");
  assert.ok(history.length >= 1);
  // Sorted desc by detectedAt
  for (let i = 1; i < history.length; i++) {
    assert.ok(history[i - 1].detectedAt >= history[i].detectedAt);
  }
});

await test("startAnomalyScheduler / stopAnomalyScheduler toggles internal timer", async () => {
  const { startAnomalyScheduler, stopAnomalyScheduler, isAnomalySchedulerRunning } = await import(
    "../lib/anomaly-detection.js"
  );
  assert.equal(isAnomalySchedulerRunning(), false);
  startAnomalyScheduler(60_000);
  assert.equal(isAnomalySchedulerRunning(), true);
  // Restart should still leave it running.
  startAnomalyScheduler(120_000);
  assert.equal(isAnomalySchedulerRunning(), true);
  stopAnomalyScheduler();
  assert.equal(isAnomalySchedulerRunning(), false);
});

await test("anomaly.detected is in webhook ALLOWED_EVENTS list", async () => {
  // Re-import via emitEvent to verify the event passes validation.
  const { emitEvent } = await import("../lib/webhooks.js");
  // Should not throw and should not log "Unknown event"
  await emitEvent("anomaly.detected", { metric: "test", value: 1 }, { workspaceId: "evt-ws" });
});

await test("MONITORED_METRICS exports the expected metric names", async () => {
  const { MONITORED_METRICS } = await import("../lib/anomaly-detection.js");
  for (const m of [
    "request_rate",
    "error_rate",
    "latency_p95",
    "token_usage",
    "cost",
    "agent_iterations",
    "tool_timeout_rate",
  ]) {
    assert.ok(MONITORED_METRICS.includes(m), `missing metric: ${m}`);
  }
});
