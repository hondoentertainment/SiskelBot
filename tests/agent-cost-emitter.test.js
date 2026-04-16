/**
 * Unit tests for lib/agent-cost-emitter.js — the shared cost.update helper
 * used by swarm, scheduled, and direct-stream call sites.
 *
 * These tests pin the public surface (emitCostUpdate, disposeRunCostAccumulator,
 * __getAccumulatorForTests, __resetAccumulatorsForTests) and verify:
 *   - cumulative totalUsd across emits
 *   - monotonic behavior
 *   - dispose clears the entry
 *   - missing sessionId: no publish, no throw
 *   - missing usage tokens: emits with zero tokens / zero usd
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-cost-emitter-"));
const prevStoragePath = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  emitCostUpdate,
  disposeRunCostAccumulator,
  __getAccumulatorForTests,
  __resetAccumulatorsForTests,
} = await import("../lib/agent-cost-emitter.js");
const {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");
const { parseCostConfig } = await import("../lib/smart-router.js");

test.after(() => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("");
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

test("emitCostUpdate publishes a cost.update with cumulative totalUsd", () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("m1:0.002");

  const sessionId = "sess-cost-1";
  const runId = "run-cost-1";
  const emitter = getAgentRunEmitter(sessionId);
  const events = [];
  emitter.on("event", (ev) => events.push(ev));

  emitCostUpdate({
    sessionId,
    runId,
    model: "m1",
    iteration: 1,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });

  const cost = events.filter((e) => e.type === "cost.update");
  assert.equal(cost.length, 1);
  const p = cost[0].payload;
  assert.equal(p.tokens.prompt, 100);
  assert.equal(p.tokens.completion, 50);
  assert.equal(p.tokens.total, 150);
  assert.equal(p.model, "m1");
  assert.equal(p.iteration, 1);
  assert.equal(p.runId, runId);
  // 150 tokens * 0.002 / 1000 = 0.0003
  assert.ok(Math.abs(p.totalUsd - 0.0003) < 1e-9, `totalUsd=${p.totalUsd}`);
});

test("two emits produce monotonic cumulative totalUsd", () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("m2:0.004");

  const sessionId = "sess-cost-2";
  const runId = "run-cost-2";
  const emitter = getAgentRunEmitter(sessionId);
  const events = [];
  emitter.on("event", (ev) => events.push(ev));

  emitCostUpdate({
    sessionId,
    runId,
    model: "m2",
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
  emitCostUpdate({
    sessionId,
    runId,
    model: "m2",
    usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
  });

  const cost = events.filter((e) => e.type === "cost.update");
  assert.equal(cost.length, 2);
  assert.ok(cost[1].payload.totalUsd >= cost[0].payload.totalUsd);
  // First: 120 * 0.004 / 1000 = 0.00048
  // Second cumulative: 350 * 0.004 / 1000 = 0.0014
  assert.ok(Math.abs(cost[0].payload.totalUsd - 0.00048) < 1e-9);
  assert.ok(Math.abs(cost[1].payload.totalUsd - 0.0014) < 1e-9);
  assert.equal(cost[1].payload.tokens.total, 350);
  assert.equal(cost[1].payload.tokens.prompt, 300);
  assert.equal(cost[1].payload.tokens.completion, 50);
});

test("disposeRunCostAccumulator removes the entry", () => {
  __resetAccumulatorsForTests();
  parseCostConfig("m3:0.001");
  const sessionId = "sess-cost-3";
  const runId = "run-cost-3";
  // Make sure an emitter exists so publish is not a total no-op.
  getAgentRunEmitter(sessionId);

  emitCostUpdate({
    sessionId,
    runId,
    model: "m3",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.ok(__getAccumulatorForTests(runId), "accumulator should exist after emit");

  disposeRunCostAccumulator(runId);
  assert.equal(__getAccumulatorForTests(runId), null);
});

test("missing sessionId — no publish, no throw", () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("m4:0.005");

  // Emitter that we watch — we want to see zero events on it.
  const sessionId = "sess-cost-watch";
  const emitter = getAgentRunEmitter(sessionId);
  const events = [];
  emitter.on("event", (ev) => events.push(ev));

  assert.doesNotThrow(() => {
    emitCostUpdate({
      runId: "run-no-session",
      model: "m4",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  // Empty string sessionId is also a no-op.
  assert.doesNotThrow(() => {
    emitCostUpdate({
      sessionId: "",
      runId: "run-no-session",
      model: "m4",
      usage: { total_tokens: 5 },
    });
  });

  assert.equal(events.length, 0);
  assert.equal(__getAccumulatorForTests("run-no-session"), null);
});

test("missing usage tokens — emits with zero tokens and zero totalUsd", () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig(""); // no cost configured for anything

  const sessionId = "sess-cost-zero";
  const runId = "run-cost-zero";
  const emitter = getAgentRunEmitter(sessionId);
  const events = [];
  emitter.on("event", (ev) => events.push(ev));

  emitCostUpdate({ sessionId, runId, model: "unknown" }); // no usage
  emitCostUpdate({ sessionId, runId, model: "unknown", usage: null });

  const cost = events.filter((e) => e.type === "cost.update");
  assert.equal(cost.length, 2);
  for (const c of cost) {
    assert.equal(c.payload.totalUsd, 0);
    assert.equal(c.payload.tokens.prompt, 0);
    assert.equal(c.payload.tokens.completion, 0);
    assert.equal(c.payload.tokens.total, 0);
  }
});
