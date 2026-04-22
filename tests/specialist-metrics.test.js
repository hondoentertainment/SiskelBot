import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "specialist-metrics-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  recordSpecialistObservation,
  getSpecialistStats,
  rankSpecialists,
  learnedRoutingEnabled,
} = await import("../lib/specialist-metrics.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("learnedRoutingEnabled: false by default", () => {
  const prev = process.env.SWARM_LEARNED_ROUTING;
  delete process.env.SWARM_LEARNED_ROUTING;
  try {
    assert.equal(learnedRoutingEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.SWARM_LEARNED_ROUTING = prev;
  }
});

test("getSpecialistStats: empty when no observations", async () => {
  const s = await getSpecialistStats("ws-empty", "sp-empty", "intent");
  assert.equal(s.count, 0);
  assert.equal(s.successRate, 0);
  assert.equal(s.avgQuality, null);
});

test("recordSpecialistObservation + getSpecialistStats roundtrip", async () => {
  await recordSpecialistObservation({
    workspace: "ws1",
    specialist: "researcher",
    intent: "research",
    latencyMs: 100,
    success: true,
    quality: 0.8,
  });
  await recordSpecialistObservation({
    workspace: "ws1",
    specialist: "researcher",
    intent: "research",
    latencyMs: 200,
    success: false,
  });
  const s = await getSpecialistStats("ws1", "researcher", "research");
  assert.equal(s.count, 2);
  assert.equal(s.successRate, 0.5);
  assert.equal(s.avgLatencyMs, 150);
  assert.ok(s.avgQuality !== null);
});

test("rankSpecialists: returns null when insufficient observations", async () => {
  const r = await rankSpecialists("ws2", "intent", ["sp-new1", "sp-new2"], 3);
  assert.equal(r, null);
});

test("rankSpecialists: orders by combined score", async () => {
  // Seed one specialist with high success, another with low
  for (let i = 0; i < 5; i++) {
    await recordSpecialistObservation({
      workspace: "ws-rank",
      specialist: "hi",
      intent: "intentX",
      latencyMs: 100,
      success: true,
    });
    await recordSpecialistObservation({
      workspace: "ws-rank",
      specialist: "lo",
      intent: "intentX",
      latencyMs: 100,
      success: false,
    });
  }
  const r = await rankSpecialists("ws-rank", "intentX", ["hi", "lo"], 3);
  assert.ok(Array.isArray(r));
  assert.equal(r[0].specialist, "hi");
  assert.ok(r[0].score > r[1].score);
});

test("recordSpecialistObservation: no-op on missing specialist", async () => {
  await recordSpecialistObservation({});
  // Should not throw and should not create data
  const s = await getSpecialistStats("ws-na", "", "intent");
  assert.equal(s.count, 0);
});
