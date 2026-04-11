/**
 * Phase 60.3: step-latency tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-steplat-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordStep,
  getBreakdown,
  getPercentiles,
  listTraces,
  clearStats,
  filterSteps,
  groupSteps,
  aggregateDurations,
} = await import("../lib/step-latency.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

async function seed() {
  await clearStats();
  await recordStep({ cortex: "planner", tool: "search", durationMs: 10, traceId: "t1" });
  await recordStep({ cortex: "planner", tool: "search", durationMs: 20, traceId: "t1" });
  await recordStep({ cortex: "planner", tool: "plan", durationMs: 30, traceId: "t1" });
  await recordStep({ cortex: "executor", tool: "run", durationMs: 50, traceId: "t2" });
  await recordStep({ cortex: "executor", tool: "run", durationMs: 100, traceId: "t2", status: "error" });
}

test("aggregateDurations computes percentiles", () => {
  const agg = aggregateDurations([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(agg.count, 10);
  assert.equal(agg.min, 10);
  assert.equal(agg.max, 100);
  assert.ok(agg.p50 >= 50 && agg.p50 <= 60);
  assert.equal(agg.p99, 100);
});

test("aggregateDurations handles empty array", () => {
  const agg = aggregateDurations([]);
  assert.equal(agg.count, 0);
  assert.equal(agg.p50, 0);
});

test("recordStep persists a step", async () => {
  await clearStats();
  const step = await recordStep({ cortex: "a", tool: "b", durationMs: 42, traceId: "tx" });
  assert.ok(step.id);
  assert.equal(step.cortex, "a");
  assert.equal(step.durationMs, 42);
  const traces = await listTraces();
  assert.ok(traces.traces.some((t) => t.traceId === "tx"));
});

test("recordStep rejects invalid duration", async () => {
  await assert.rejects(() => recordStep({ cortex: "a", tool: "b", durationMs: -5 }));
  await assert.rejects(() => recordStep({ cortex: "a", tool: "b" }));
  await assert.rejects(() => recordStep(null));
});

test("filterSteps + groupSteps combine correctly", () => {
  const steps = [
    { cortex: "a", tool: "x", durationMs: 10, startedAt: new Date().toISOString(), status: "ok" },
    { cortex: "a", tool: "y", durationMs: 20, startedAt: new Date().toISOString(), status: "error" },
    { cortex: "b", tool: "x", durationMs: 30, startedAt: new Date().toISOString(), status: "ok" },
  ];
  const filtered = filterSteps(steps, { cortex: "a" });
  assert.equal(filtered.length, 2);
  const groups = groupSteps(filtered, "tool");
  assert.ok(groups.get("x"));
  assert.ok(groups.get("y"));
});

test("getBreakdown groups by cortex:tool and counts errors", async () => {
  await seed();
  const result = await getBreakdown();
  assert.equal(result.totalSteps, 5);
  const executorRun = result.rows.find((r) => r.key === "executor:run");
  assert.ok(executorRun);
  assert.equal(executorRun.count, 2);
  assert.equal(executorRun.total, 150);
  assert.equal(executorRun.errorCount, 1);
  assert.equal(executorRun.errorRate, 0.5);
});

test("getBreakdown supports groupBy=cortex", async () => {
  await seed();
  const result = await getBreakdown({ groupBy: "cortex" });
  const planner = result.rows.find((r) => r.key === "planner");
  assert.ok(planner);
  assert.equal(planner.count, 3);
});

test("getPercentiles returns p50/p95/p99", async () => {
  await seed();
  const result = await getPercentiles();
  const plannerSearch = result.rows.find((r) => r.key === "planner:search");
  assert.ok(plannerSearch);
  assert.equal(plannerSearch.count, 2);
  assert.ok(plannerSearch.p95 >= plannerSearch.p50);
});

test("listTraces groups by traceId ordered by startedAt", async () => {
  await seed();
  const result = await listTraces();
  assert.ok(result.traces.some((t) => t.traceId === "t1"));
  assert.ok(result.traces.some((t) => t.traceId === "t2"));
  const t1 = result.traces.find((t) => t.traceId === "t1");
  assert.equal(t1.stepCount, 3);
  assert.equal(t1.totalMs, 60);
});

test("listTraces respects limit", async () => {
  await seed();
  const result = await listTraces({ limit: 1 });
  assert.equal(result.traces.length, 1);
});

test("getBreakdown respects filter", async () => {
  await seed();
  const result = await getBreakdown({ filter: { traceId: "t2" } });
  assert.equal(result.totalSteps, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].key, "executor:run");
});

test("clearStats empties the store", async () => {
  await seed();
  const cleared = await clearStats();
  assert.ok(cleared.cleared >= 5);
  const result = await getBreakdown();
  assert.equal(result.totalSteps, 0);
});
