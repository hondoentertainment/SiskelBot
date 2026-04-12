/**
 * Phase 60.3: Step-level latency tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-step-latency-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordStep,
  getLatencyReport,
  getBreakdownByCortex,
  getBreakdownByTool,
  persistRollup,
  loadPersistedRollup,
  attachSpanListener,
  resetLatency,
} = await import("../lib/step-latency.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test.beforeEach(() => {
  resetLatency();
});

// ─── Recording ────────────────────────────────────────────────────────────

test("recordStep validates latencyMs is a finite non-negative number", () => {
  assert.throws(() => recordStep({ cortex: "swarm", tool: "x", latencyMs: "bad" }));
  assert.throws(() => recordStep({ cortex: "swarm", tool: "x", latencyMs: -1 }));
});

test("recordStep accumulates counts and totals", () => {
  recordStep({ cortex: "swarm", tool: "web_search", latencyMs: 100 });
  recordStep({ cortex: "swarm", tool: "web_search", latencyMs: 200 });
  const report = getLatencyReport();
  assert.equal(report.steps.length, 1);
  const step = report.steps[0];
  assert.equal(step.count, 2);
  assert.equal(step.avgMs, 150);
  assert.equal(step.cortex, "swarm");
  assert.equal(step.tool, "web_search");
});

test("recordStep counts errors when ok is false", () => {
  recordStep({ cortex: "agent", tool: "query_db", latencyMs: 50, ok: false });
  recordStep({ cortex: "agent", tool: "query_db", latencyMs: 60, ok: true });
  const report = getLatencyReport();
  const step = report.steps.find((s) => s.tool === "query_db");
  assert.equal(step.errors, 1);
  assert.ok(step.errorRate > 0 && step.errorRate < 1);
});

// ─── Percentiles ──────────────────────────────────────────────────────────

test("getLatencyReport computes p50/p95/p99 percentiles", () => {
  for (let i = 1; i <= 100; i += 1) {
    recordStep({ cortex: "c", tool: "t", latencyMs: i });
  }
  const step = getLatencyReport().steps[0];
  assert.ok(step.p50Ms >= 45 && step.p50Ms <= 55);
  assert.ok(step.p95Ms >= 90 && step.p95Ms <= 100);
  assert.ok(step.p99Ms >= 95);
});

// ─── Breakdowns ───────────────────────────────────────────────────────────

test("getBreakdownByCortex aggregates all tools per cortex", () => {
  recordStep({ cortex: "swarm", tool: "a", latencyMs: 100 });
  recordStep({ cortex: "swarm", tool: "b", latencyMs: 200 });
  recordStep({ cortex: "agent", tool: "a", latencyMs: 300 });
  const report = getBreakdownByCortex();
  const swarm = report.cortexes.find((r) => r.cortex === "swarm");
  const agent = report.cortexes.find((r) => r.cortex === "agent");
  assert.equal(swarm.toolCount, 2);
  assert.equal(swarm.count, 2);
  assert.equal(agent.toolCount, 1);
  assert.equal(agent.count, 1);
});

test("getBreakdownByTool aggregates across cortexes", () => {
  recordStep({ cortex: "swarm", tool: "shared", latencyMs: 100 });
  recordStep({ cortex: "agent", tool: "shared", latencyMs: 200 });
  recordStep({ cortex: "agent", tool: "solo", latencyMs: 50 });
  const report = getBreakdownByTool();
  const shared = report.tools.find((t) => t.tool === "shared");
  const solo = report.tools.find((t) => t.tool === "solo");
  assert.equal(shared.cortexCount, 2);
  assert.equal(shared.count, 2);
  assert.equal(solo.cortexCount, 1);
  assert.equal(solo.count, 1);
});

// ─── Persistence ──────────────────────────────────────────────────────────

test("persistRollup saves summary to disk and loadPersistedRollup returns it", async () => {
  recordStep({ cortex: "swarm", tool: "web_search", latencyMs: 100 });
  recordStep({ cortex: "swarm", tool: "web_search", latencyMs: 200 });
  await persistRollup();
  const loaded = await loadPersistedRollup();
  assert.ok(Array.isArray(loaded.steps));
  assert.ok(loaded.steps.length >= 1);
  assert.equal(loaded.steps[0].tool, "web_search");
});

// ─── Span listener ────────────────────────────────────────────────────────

test("attachSpanListener harvests latency from span emissions", () => {
  let emitSpan;
  const unsub = attachSpanListener((cb) => {
    emitSpan = cb;
    return () => {};
  });
  // Simulate a span emission (OTel-style).
  emitSpan({
    name: "tool.exec",
    attributes: { "siskel.cortex": "swarm", "siskel.tool": "web_search" },
    durationMs: 123,
    status: { code: 1 },
  });
  const step = getLatencyReport().steps[0];
  assert.equal(step.cortex, "swarm");
  assert.equal(step.tool, "web_search");
  assert.equal(step.count, 1);
  if (typeof unsub === "function") unsub();
});

test("attachSpanListener tolerates malformed spans without crashing", () => {
  let emitSpan;
  attachSpanListener((cb) => { emitSpan = cb; return () => {}; });
  emitSpan(null);
  emitSpan({});
  emitSpan({ name: "x", duration: "not-a-number" });
  const report = getLatencyReport();
  assert.equal(report.steps.length, 0);
});

// ─── Reset ────────────────────────────────────────────────────────────────

test("resetLatency clears the rollup", () => {
  recordStep({ cortex: "c", tool: "t", latencyMs: 10 });
  resetLatency();
  const report = getLatencyReport();
  assert.equal(report.totalKeys, 0);
  assert.equal(report.totalCount, 0);
});
