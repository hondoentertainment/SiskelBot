/**
 * Tests for lib/gbrain.js — the GBrain core cortex.
 *
 * These tests use an isolated STORAGE_PATH (mkdtempSync) and stub the
 * subsystem dispatchers via setSubsystem so we never pull in the heavy
 * agent-loop / swarm modules. Each test verifies one slice of the
 * think → execute → learn pipeline plus the read helpers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STORAGE_PATH = mkdtempSync(join(tmpdir(), "gbrain-test-"));
process.env.STORAGE_BACKEND = "file";

const {
  think,
  execute,
  learn,
  getBrainState,
  getRecentThoughts,
  getThought,
  analyzeTask,
  selectStrategy,
  buildPlan,
  CORTICES,
  _resetStore,
} = await import("../lib/gbrain.js");

const { setSubsystem, resetSubsystems } = await import("../lib/gbrain-router.js");

test.beforeEach(async () => {
  await _resetStore();
  resetSubsystems();
  // Default stubs for every strategy so execute() never touches agent-loop.js.
  for (const id of [
    "direct",
    "agent_loop",
    "swarm",
    "hierarchy",
    "consensus",
    "mission",
    "reflection",
  ]) {
    setSubsystem(id, async (task) => ({ strategy: id, echo: String(task).slice(0, 64) }));
  }
});

test.after(() => {
  resetSubsystems();
});

test("CORTICES exposes the eight named cortices", () => {
  assert.equal(CORTICES.length, 8);
  const ids = CORTICES.map((c) => c.id);
  assert.deepEqual(ids.sort(), [
    "emotion",
    "execution",
    "learning",
    "memory",
    "perception",
    "planning",
    "reasoning",
    "reflection",
  ]);
  for (const cortex of CORTICES) {
    assert.equal(typeof cortex.name, "string");
    assert.equal(typeof cortex.description, "string");
  }
});

test("analyzeTask classifies a simple question", async () => {
  const analysis = await analyzeTask("What is the capital of France?", { skipMemory: true });
  assert.equal(analysis.type, "converse");
  assert.equal(analysis.simpleQuestion, true);
  assert.equal(analysis.riskLevel, "low");
  assert.ok(analysis._heuristics);
});

test("analyzeTask classifies a troubleshooting task", async () => {
  const analysis = await analyzeTask("Please help me debug the failing test suite", { skipMemory: true });
  assert.equal(analysis.type, "troubleshoot");
});

test("analyzeTask classifies a research task", async () => {
  const analysis = await analyzeTask("Research the best approach for rate limiting", { skipMemory: true });
  assert.equal(analysis.type, "research");
});

test("analyzeTask classifies a creation task", async () => {
  const analysis = await analyzeTask("Write a poem about stars", { skipMemory: true });
  assert.equal(analysis.type, "create");
});

test("selectStrategy returns a valid strategy id", async () => {
  const analysis = await analyzeTask("Hello", { skipMemory: true });
  const result = await selectStrategy(analysis);
  assert.ok(result.strategy);
  assert.ok(
    [
      "direct",
      "agent_loop",
      "swarm",
      "hierarchy",
      "consensus",
      "mission",
      "reflection",
    ].includes(result.strategy),
  );
});

test("buildPlan produces an ordered cortex pipeline", async () => {
  const analysis = await analyzeTask("Hi", { skipMemory: true });
  const choice = { strategy: "direct" };
  const plan = buildPlan("Hi", analysis, choice);
  const expected = [
    "perception",
    "memory",
    "reasoning",
    "planning",
    "execution",
    "reflection",
    "learning",
  ];
  assert.deepEqual(plan.steps.map((s) => s.cortex), expected);
  assert.match(plan.id, /^th_[a-f0-9]+$/);
  assert.equal(plan.strategy, "direct");
});

test("think returns a plan with a stable id", async () => {
  const plan = await think("Say hello", { skipMemory: true });
  assert.match(plan.id, /^th_[a-f0-9]+$/);
  assert.ok(plan.strategy);
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.createdAt);
});

test("think rejects missing task", async () => {
  await assert.rejects(think(null), /task is required/);
  await assert.rejects(think(undefined), /task is required/);
});

test("think persists the thought and increments cortex activity", async () => {
  await think("Hello", { skipMemory: true });
  const state = await getBrainState();
  assert.equal(state.totalThoughts, 1);
  assert.ok(state.cortexActivity.perception >= 1);
  assert.ok(state.cortexActivity.reasoning >= 1);
});

test("execute dispatches to the selected strategy stub", async () => {
  const plan = await think("Tell me a joke", { skipMemory: true });
  setSubsystem(plan.strategy, async (task) => ({ said: `joke:${task}` }));
  const result = await execute(plan);
  assert.equal(result.success, true);
  assert.equal(result.thoughtId, plan.id);
  assert.deepEqual(result.output, { said: "joke:Tell me a joke" });
});

test("execute records a failure when the subsystem throws", async () => {
  const plan = await think("boom", { skipMemory: true });
  setSubsystem(plan.strategy, async () => {
    throw new Error("kapow");
  });
  const result = await execute(plan);
  assert.equal(result.success, false);
  assert.equal(result.error, "kapow");
  const thought = await getThought(plan.id);
  assert.equal(thought.status, "failed");
  assert.equal(thought.error, "kapow");
});

test("execute marks the execution step done in the stored thought", async () => {
  const plan = await think("Hi again", { skipMemory: true });
  await execute(plan);
  const thought = await getThought(plan.id);
  const executionStep = thought.steps.find((s) => s.cortex === "execution");
  assert.equal(executionStep.done, true);
});

test("getBrainState reports success rate after execute", async () => {
  const plan = await think("ok", { skipMemory: true });
  await execute(plan);
  const state = await getBrainState();
  assert.equal(state.totalThoughts, 1);
  assert.ok(state.successRate > 0);
  assert.ok(state.cortexActivity.execution >= 1);
});

test("learn marks reflection and learning cortices active", async () => {
  const plan = await think("learn me", { skipMemory: true });
  await execute(plan);
  const result = await learn({ thoughtId: plan.id, success: true, rating: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
  const thought = await getThought(plan.id);
  assert.equal(thought.rating, 5);
  const reflection = thought.steps.find((s) => s.cortex === "reflection");
  const learning = thought.steps.find((s) => s.cortex === "learning");
  assert.equal(reflection.done, true);
  assert.equal(learning.done, true);
});

test("learn returns ok=false-applied for unknown thoughtId", async () => {
  const result = await learn({ thoughtId: "th_nonexistent", outcome: "ignored" });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
});

test("getRecentThoughts returns newest first with pagination", async () => {
  for (let i = 0; i < 5; i++) {
    await think(`task ${i}`, { skipMemory: true });
  }
  const page1 = await getRecentThoughts({ limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.equal(page1.thoughts.length, 2);
  assert.equal(page1.thoughts[0].task, "task 4");
  const page2 = await getRecentThoughts({ limit: 2, offset: 2 });
  assert.equal(page2.thoughts.length, 2);
  assert.equal(page2.thoughts[0].task, "task 2");
});

test("getThought returns null for unknown id", async () => {
  const result = await getThought("th_missing");
  assert.equal(result, null);
});

test("getBrainState handles empty store", async () => {
  const state = await getBrainState();
  assert.equal(state.totalThoughts, 0);
  assert.equal(state.successRate, 0);
  assert.equal(state.avgConfidence, 0);
  assert.equal(Object.keys(state.strategyDistribution).length, 0);
  assert.equal(state.cortices.length, 8);
});

test("think accepts an object task", async () => {
  const plan = await think({ prompt: "do the thing", priority: "high" }, { skipMemory: true });
  assert.ok(plan.id);
  assert.equal(typeof plan.task, "object");
});

test("think sanitizes context to known keys only", async () => {
  const plan = await think("hello", {
    skipMemory: true,
    userId: "u1",
    workspaceId: "w1",
    secret: "should-not-persist",
    huge: new Array(1000).fill("x"),
  });
  const thought = await getThought(plan.id);
  assert.equal(thought.context.userId, "u1");
  assert.equal(thought.context.workspaceId, "w1");
  assert.equal(thought.context.secret, undefined);
  assert.equal(thought.context.huge, undefined);
});
