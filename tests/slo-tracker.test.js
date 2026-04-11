import test from "node:test";
import assert from "node:assert/strict";
import { createSLOTracker, parseWindow, __test__ } from "../lib/slo-tracker.js";

function makeTracker() {
  return createSLOTracker();
}

test("slo-tracker: parseWindow handles named windows and Nx units", () => {
  assert.equal(parseWindow("1h"), 60 * 60 * 1000);
  assert.equal(parseWindow("24h"), 24 * 60 * 60 * 1000);
  assert.equal(parseWindow("7d"), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseWindow("30d"), 30 * 24 * 60 * 60 * 1000);
  assert.equal(parseWindow("5m"), 5 * 60 * 1000);
  assert.equal(parseWindow("90s"), 90 * 1000);
  assert.equal(parseWindow(12345), 12345);
});

test("slo-tracker: defaults are seeded", () => {
  const t = makeTracker();
  const all = t.getAllSLOs();
  const names = all.map((s) => s.name).sort();
  assert.deepEqual(names, ["availability", "error_rate", "latency_p95"]);
  for (const slo of all) {
    assert.ok(slo.budget);
    assert.ok(["healthy", "warning", "critical"].includes(slo.status));
  }
});

test("slo-tracker: setSLO creates and updates SLOs", () => {
  const t = makeTracker();
  const cfg = t.setSLO("custom_availability", {
    target: 0.995,
    metric: "success_rate",
    window: "24h",
    operator: "gte",
    description: "test availability",
  });
  assert.equal(cfg.target, 0.995);
  const status = t.getSLOStatus("custom_availability");
  assert.ok(status);
  assert.equal(status.name, "custom_availability");
  assert.equal(status.target, 0.995);

  // Update
  t.setSLO("custom_availability", { target: 0.9999, metric: "success_rate" });
  assert.equal(t.getSLOStatus("custom_availability").target, 0.9999);
});

test("slo-tracker: setSLO rejects invalid input", () => {
  const t = makeTracker();
  assert.throws(() => t.setSLO("", { target: 1, metric: "x" }));
  assert.throws(() => t.setSLO("foo", null));
  assert.throws(() => t.setSLO("foo", { target: "bad", metric: "x" }));
  assert.throws(() => t.setSLO("foo", { target: 1 }));
});

test("slo-tracker: deleteSLO removes an SLO", () => {
  const t = makeTracker();
  t.setSLO("doomed", { target: 0.99, metric: "success_rate" });
  assert.ok(t.getSLOStatus("doomed"));
  assert.equal(t.deleteSLO("doomed"), true);
  assert.equal(t.getSLOStatus("doomed"), null);
  assert.equal(t.deleteSLO("nonexistent"), false);
});

test("slo-tracker: getSLOStatus returns null for unknown names", () => {
  const t = makeTracker();
  assert.equal(t.getSLOStatus("nope"), null);
});

test("slo-tracker: records success_rate events and computes current value", () => {
  const t = makeTracker();
  // 9 successes and 1 failure => 0.9 success_rate
  for (let i = 0; i < 9; i++) t.recordEvent("success_rate", 1);
  t.recordEvent("success_rate", 0);
  const status = t.getSLOStatus("availability");
  assert.equal(status.sampleSize, 10);
  assert.equal(Number(status.current.toFixed(2)), 0.9);
});

test("slo-tracker: healthy status when burn rate < 2", () => {
  const t = makeTracker();
  // Target 99.9%, 0.1% error budget. 1000 samples with 1 failure => 0.001 failure rate,
  // burn rate = 0.001 / 0.001 = 1.0 => healthy.
  for (let i = 0; i < 999; i++) t.recordEvent("success_rate", 1);
  t.recordEvent("success_rate", 0);
  const status = t.getSLOStatus("availability");
  assert.equal(status.status, "healthy");
  assert.ok(status.budget.burnRate <= 2);
});

test("slo-tracker: warning status when burn rate between 2 and 10", () => {
  const t = makeTracker();
  // Target 99.9%. Inject a higher failure rate: 100 samples, 1 failure = 1% failure,
  // burn rate = 0.01 / 0.001 = 10 => critical. Use 1 in 250 for warning region.
  for (let i = 0; i < 249; i++) t.recordEvent("success_rate", 1);
  t.recordEvent("success_rate", 0);
  const status = t.getSLOStatus("availability");
  // 1/250 = 0.004; burn = 0.004/0.001 = 4 → warning
  assert.equal(status.status, "warning");
  assert.ok(status.budget.burnRate >= 2 && status.budget.burnRate < 10);
});

test("slo-tracker: critical status when burn rate >= 10", () => {
  const t = makeTracker();
  // 100 samples with 2 failures = 2% failure, burn = 0.02/0.001 = 20 → critical
  for (let i = 0; i < 98; i++) t.recordEvent("success_rate", 1);
  t.recordEvent("success_rate", 0);
  t.recordEvent("success_rate", 0);
  const status = t.getSLOStatus("availability");
  assert.equal(status.status, "critical");
  assert.ok(status.budget.burnRate >= 10);
});

test("slo-tracker: burn rate calculation matches actualErrorRate/targetErrorRate", () => {
  const t = makeTracker();
  t.setSLO("avail_test", { target: 0.99, metric: "success_rate", window: "1h", operator: "gte" });
  for (let i = 0; i < 100; i++) t.recordEvent("success_rate", i < 95 ? 1 : 0);
  const status = t.getSLOStatus("avail_test");
  // actualError = 5/100 = 0.05, target error budget = 0.01, burn = 5
  assert.equal(Number(status.budget.burnRate.toFixed(2)), 5);
});

test("slo-tracker: latency p95 SLO uses percentile and fails when exceeded", () => {
  const t = makeTracker();
  // Record 100 values: 0..99. p95 ≈ 94ish. Set target < p95 to trip it.
  for (let i = 0; i < 100; i++) t.recordEvent("latency_ms", i);
  t.setSLO("latency_test", {
    target: 50,
    metric: "latency_ms",
    window: "1h",
    operator: "lt",
    percentile: 95,
  });
  const status = t.getSLOStatus("latency_test");
  assert.ok(status.current > 50);
  // Half the samples exceed 50, allowed fraction is 0.05 → burn rate ~10
  assert.ok(status.budget.burnRate > 1);
});

test("slo-tracker: latency p95 SLO healthy when all samples under target", () => {
  const t = makeTracker();
  for (let i = 0; i < 100; i++) t.recordEvent("latency_ms", 10);
  t.setSLO("latency_ok", {
    target: 500,
    metric: "latency_ms",
    window: "1h",
    operator: "lt",
    percentile: 95,
  });
  const status = t.getSLOStatus("latency_ok");
  assert.equal(status.status, "healthy");
  assert.equal(status.budget.burnRate, 0);
});

test("slo-tracker: error_rate SLO derives from success_rate events when none recorded", () => {
  const t = makeTracker();
  for (let i = 0; i < 100; i++) t.recordEvent("success_rate", i < 95 ? 1 : 0);
  const status = t.getSLOStatus("error_rate");
  // target error_rate 0.01, actual 0.05 → burn 5
  assert.equal(Number(status.current.toFixed(2)), 0.05);
  assert.equal(Number(status.budget.burnRate.toFixed(2)), 5);
});

test("slo-tracker: window aggregation excludes events outside the window", () => {
  const t = makeTracker();
  const now = Date.now();
  const oldTs = now - (40 * 24 * 60 * 60 * 1000); // 40 days ago, outside 30d window
  t.recordEvent("success_rate", 0, oldTs); // old failure
  t.recordEvent("success_rate", 0, oldTs);
  // Recent: all success
  for (let i = 0; i < 10; i++) t.recordEvent("success_rate", 1);
  const status = t.getSLOStatus("availability");
  // Only recent 10 events should be counted
  assert.equal(status.sampleSize, 10);
  assert.equal(status.current, 1);
});

test("slo-tracker: getBurnDown returns a series of the requested length", () => {
  const t = makeTracker();
  for (let i = 0; i < 200; i++) t.recordEvent("success_rate", i % 10 === 0 ? 0 : 1);
  const burn = t.getBurnDown("availability", "24h", 12);
  assert.ok(burn);
  assert.equal(burn.name, "availability");
  assert.equal(burn.bucketCount, 12);
  assert.equal(burn.series.length, 12);
  for (const point of burn.series) {
    assert.ok(point.timestamp > 0);
    assert.ok(point.remainingFraction >= 0 && point.remainingFraction <= 1);
    assert.ok(point.consumedFraction >= 0 && point.consumedFraction <= 1);
  }
});

test("slo-tracker: getBurnDown returns null for unknown SLO", () => {
  const t = makeTracker();
  assert.equal(t.getBurnDown("nope", "24h"), null);
});

test("slo-tracker: classifyStatus threshold transitions", () => {
  assert.equal(__test__.classifyStatus(0), "healthy");
  assert.equal(__test__.classifyStatus(1), "healthy");
  assert.equal(__test__.classifyStatus(1.99), "healthy");
  assert.equal(__test__.classifyStatus(2), "warning");
  assert.equal(__test__.classifyStatus(5), "warning");
  assert.equal(__test__.classifyStatus(9.99), "warning");
  assert.equal(__test__.classifyStatus(10), "critical");
  assert.equal(__test__.classifyStatus(100), "critical");
});

test("slo-tracker: recordEvent ignores invalid values", () => {
  const t = makeTracker();
  t.recordEvent("success_rate", "not a number");
  t.recordEvent("", 1);
  t.recordEvent(null, 1);
  const status = t.getSLOStatus("availability");
  assert.equal(status.sampleSize, 0);
});

test("slo-tracker: reset wipes events and restores defaults", () => {
  const t = makeTracker();
  t.recordEvent("success_rate", 0);
  t.setSLO("custom", { target: 0.5, metric: "success_rate" });
  t.reset();
  assert.equal(t.getSLOStatus("custom"), null);
  assert.equal(t.getSLOStatus("availability").sampleSize, 0);
});

test("slo-tracker: getAllSLOs returns array of statuses", () => {
  const t = makeTracker();
  const all = t.getAllSLOs();
  assert.ok(Array.isArray(all));
  assert.ok(all.length >= 3);
  for (const item of all) {
    assert.ok(item.name);
    assert.ok(item.budget);
  }
});
