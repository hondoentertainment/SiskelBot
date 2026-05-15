import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-hooks-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const {
  runUpfrontPlanHook,
  runMidLoopCritiqueHook,
  runSemanticTrimHook,
  runFailureMemoryHook,
} = await import("../lib/agent-loop-hooks.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

const trajCollector = { record: () => {} };

test("runUpfrontPlanHook: no-op when flag off", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  delete process.env.AGENT_UPFRONT_PLAN;
  try {
    const messages = [];
    const r = await runUpfrontPlanHook({
      messages,
      userMessage: "x",
      backendFetch: async () => ({ ok: true, json: async () => ({}) }),
      url: "u",
      model: "m",
      headers: {},
      trajCollector,
    });
    assert.equal(r.planInjected, false);
    assert.equal(messages.length, 0);
  } finally {
    if (prev !== undefined) process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runUpfrontPlanHook: injects plan when flag on and planner succeeds", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    const messages = [];
    const stub = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ steps: [{ id: 1, goal: "find" }], done_criteria: "x" }) } }],
      }),
    });
    const r = await runUpfrontPlanHook({ messages, userMessage: "find files", backendFetch: stub, url: "u", model: "m", headers: {}, trajCollector });
    assert.equal(r.planInjected, true);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, "system");
    assert.ok(r.planDag && r.planDag.kind === "upfront");
    assert.equal(Array.isArray(r.planDag.steps), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runUpfrontPlanHook: no-op when userMessage is empty", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    const messages = [];
    const r = await runUpfrontPlanHook({ messages, userMessage: "", backendFetch: async () => ({}), url: "u", model: "m", headers: {}, trajCollector });
    assert.equal(r.planInjected, false);
    assert.equal(messages.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runUpfrontPlanHook: tolerates planner error", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    const messages = [];
    const stub = async () => { throw new Error("boom"); };
    const r = await runUpfrontPlanHook({ messages, userMessage: "x", backendFetch: stub, url: "u", model: "m", headers: {}, trajCollector });
    assert.equal(r.planInjected, false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runMidLoopCritiqueHook: no-op when flag off", async () => {
  const prev = process.env.AGENT_MID_LOOP_CRITIQUE;
  delete process.env.AGENT_MID_LOOP_CRITIQUE;
  try {
    const r = await runMidLoopCritiqueHook({
      iteration: 3,
      currentStagnation: null,
      messages: [],
      userGoal: "x",
      backendFetch: async () => ({}),
      url: "u",
      model: "m",
      headers: {},
      trajCollector,
      storageUserId: "u",
      workspace: "w",
    });
    assert.equal(r.ran, false);
  } finally {
    if (prev !== undefined) process.env.AGENT_MID_LOOP_CRITIQUE = prev;
  }
});

test("runMidLoopCritiqueHook: off-track verdict appends nudge", async () => {
  const prevC = process.env.AGENT_MID_LOOP_CRITIQUE;
  const prevI = process.env.AGENT_CRITIQUE_INTERVAL;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  process.env.AGENT_CRITIQUE_INTERVAL = "1";
  try {
    const messages = [];
    const stub = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ on_track: false, stuck_reason: "stuck", suggestion: "try X" }) } }],
      }),
    });
    const r = await runMidLoopCritiqueHook({
      iteration: 1,
      currentStagnation: null,
      messages,
      userGoal: "goal",
      backendFetch: stub,
      url: "u",
      model: "m",
      headers: {},
      trajCollector,
      storageUserId: "u",
      workspace: "w",
    });
    assert.equal(r.ran, true);
    assert.equal(r.onTrack, false);
    assert.equal(r.nudged, true);
    assert.equal(messages.length, 1);
  } finally {
    if (prevC === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prevC;
    if (prevI === undefined) delete process.env.AGENT_CRITIQUE_INTERVAL;
    else process.env.AGENT_CRITIQUE_INTERVAL = prevI;
  }
});

test("runMidLoopCritiqueHook: on-track verdict skips nudge", async () => {
  const prevC = process.env.AGENT_MID_LOOP_CRITIQUE;
  const prevI = process.env.AGENT_CRITIQUE_INTERVAL;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  process.env.AGENT_CRITIQUE_INTERVAL = "1";
  try {
    const messages = [];
    const stub = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ on_track: true }) } }] }) });
    const r = await runMidLoopCritiqueHook({
      iteration: 1, currentStagnation: null, messages, userGoal: "goal", backendFetch: stub, url: "u", model: "m", headers: {}, trajCollector, storageUserId: "u", workspace: "w",
    });
    assert.equal(r.onTrack, true);
    assert.equal(r.nudged, false);
    assert.equal(messages.length, 0);
  } finally {
    if (prevC === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prevC;
    if (prevI === undefined) delete process.env.AGENT_CRITIQUE_INTERVAL;
    else process.env.AGENT_CRITIQUE_INTERVAL = prevI;
  }
});

test("runMidLoopCritiqueHook: null verdict is tolerated", async () => {
  const prevC = process.env.AGENT_MID_LOOP_CRITIQUE;
  const prevI = process.env.AGENT_CRITIQUE_INTERVAL;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  process.env.AGENT_CRITIQUE_INTERVAL = "1";
  try {
    const stub = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) });
    const r = await runMidLoopCritiqueHook({
      iteration: 1, currentStagnation: null, messages: [], userGoal: "goal", backendFetch: stub, url: "u", model: "m", headers: {}, trajCollector, storageUserId: "u", workspace: "w",
    });
    assert.equal(r.ran, true);
    assert.equal(r.onTrack, null);
  } finally {
    if (prevC === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prevC;
    if (prevI === undefined) delete process.env.AGENT_CRITIQUE_INTERVAL;
    else process.env.AGENT_CRITIQUE_INTERVAL = prevI;
  }
});

test("runSemanticTrimHook: no-op when flag off", () => {
  const prev = process.env.AGENT_SEMANTIC_TRIM;
  delete process.env.AGENT_SEMANTIC_TRIM;
  try {
    const messages = [{ role: "user", content: "x" }];
    const r = runSemanticTrimHook({ messages, userGoal: "x", trajCollector });
    assert.equal(r.roundsRemoved, 0);
    assert.equal(r.trimmedMessages, messages);
  } finally {
    if (prev !== undefined) process.env.AGENT_SEMANTIC_TRIM = prev;
  }
});

test("runSemanticTrimHook: no-op when budget is 0", () => {
  const prev = process.env.AGENT_SEMANTIC_TRIM;
  const prevB = process.env.AGENT_SEMANTIC_TRIM_BUDGET;
  process.env.AGENT_SEMANTIC_TRIM = "1";
  delete process.env.AGENT_SEMANTIC_TRIM_BUDGET;
  try {
    const messages = [{ role: "user", content: "x" }];
    const r = runSemanticTrimHook({ messages, userGoal: "x", trajCollector });
    assert.equal(r.roundsRemoved, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_SEMANTIC_TRIM;
    else process.env.AGENT_SEMANTIC_TRIM = prev;
    if (prevB !== undefined) process.env.AGENT_SEMANTIC_TRIM_BUDGET = prevB;
  }
});

test("runSemanticTrimHook: trims when budget exceeded", () => {
  const prev = process.env.AGENT_SEMANTIC_TRIM;
  const prevB = process.env.AGENT_SEMANTIC_TRIM_BUDGET;
  process.env.AGENT_SEMANTIC_TRIM = "1";
  process.env.AGENT_SEMANTIC_TRIM_BUDGET = "10";
  try {
    const messages = [
      { role: "user", content: "deploy app" },
      { role: "assistant", tool_calls: [{ id: "a", function: { name: "s", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "deploy info long ".repeat(50) },
      { role: "assistant", tool_calls: [{ id: "b", function: { name: "s", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "b", content: "unrelated ".repeat(50) },
    ];
    const r = runSemanticTrimHook({ messages, userGoal: "deploy app", trajCollector });
    assert.ok(r.roundsRemoved >= 1);
  } finally {
    if (prev === undefined) delete process.env.AGENT_SEMANTIC_TRIM;
    else process.env.AGENT_SEMANTIC_TRIM = prev;
    if (prevB === undefined) delete process.env.AGENT_SEMANTIC_TRIM_BUDGET;
    else process.env.AGENT_SEMANTIC_TRIM_BUDGET = prevB;
  }
});

test("runFailureMemoryHook: no-op when flag off", () => {
  const prev = process.env.AGENT_FAILURE_MEMORY;
  delete process.env.AGENT_FAILURE_MEMORY;
  try {
    runFailureMemoryHook({ userId: "u", workspaceId: "w", kind: "stagnation" });
    // Should not throw
    assert.ok(true);
  } finally {
    if (prev !== undefined) process.env.AGENT_FAILURE_MEMORY = prev;
  }
});

test("runFailureMemoryHook: dispatches to recordFailure when flag on", () => {
  const prev = process.env.AGENT_FAILURE_MEMORY;
  process.env.AGENT_FAILURE_MEMORY = "1";
  try {
    // Should not throw; recordFailure itself is best-effort
    runFailureMemoryHook({ userId: "u-hooks", workspaceId: "w-hooks", kind: "stagnation", details: "x" });
    assert.ok(true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_FAILURE_MEMORY;
    else process.env.AGENT_FAILURE_MEMORY = prev;
  }
});
