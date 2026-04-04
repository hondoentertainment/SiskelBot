import test from "node:test";
import assert from "node:assert/strict";
import { detectStagnation, stagnationDetectionEnabled } from "../lib/agent-stagnation.js";

test("stagnationDetectionEnabled returns true by default", () => {
  const orig = process.env.AGENT_STAGNATION_STOP;
  delete process.env.AGENT_STAGNATION_STOP;
  assert.equal(stagnationDetectionEnabled(), true);
  if (orig !== undefined) process.env.AGENT_STAGNATION_STOP = orig;
});

test("stagnationDetectionEnabled returns false when AGENT_STAGNATION_STOP=0", (t) => {
  const orig = process.env.AGENT_STAGNATION_STOP;
  process.env.AGENT_STAGNATION_STOP = "0";
  t.after(() => {
    if (orig !== undefined) process.env.AGENT_STAGNATION_STOP = orig;
    else delete process.env.AGENT_STAGNATION_STOP;
  });
  assert.equal(stagnationDetectionEnabled(), false);
});

test("detectStagnation returns false for empty array", () => {
  assert.equal(detectStagnation([]), false);
});

test("detectStagnation returns false for single entry", () => {
  assert.equal(detectStagnation([{ name: "search", args: { q: "test" }, iteration: 1 }]), false);
});

test("detectStagnation returns false for non-array input", () => {
  assert.equal(detectStagnation(null), false);
  assert.equal(detectStagnation(undefined), false);
  assert.equal(detectStagnation("string"), false);
});

test("detectStagnation returns false for diverse tool calls across iterations", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "list_context", args: {}, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), false);
});

test("detectStagnation returns true for identical tool calls in consecutive iterations", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "search_context", args: { q: "hello" }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), true);
});

test("detectStagnation returns true for identical multi-tool calls in consecutive iterations", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "list_context", args: {}, iteration: 1 },
    { name: "search_context", args: { q: "hello" }, iteration: 2 },
    { name: "list_context", args: {}, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), true);
});

test("detectStagnation returns false when args differ between iterations", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "search_context", args: { q: "world" }, iteration: 2 },
  ];
  assert.equal(detectStagnation(log), false);
});

test("detectStagnation handles arg key ordering correctly", () => {
  const log = [
    { name: "search_context", args: { q: "hello", limit: 10 }, iteration: 1 },
    { name: "search_context", args: { limit: 10, q: "hello" }, iteration: 2 },
  ];
  // Should detect as stagnation since sorted keys match
  assert.equal(detectStagnation(log), true);
});

test("detectStagnation only compares last two iterations", () => {
  const log = [
    { name: "search_context", args: { q: "hello" }, iteration: 1 },
    { name: "search_context", args: { q: "hello" }, iteration: 2 },
    { name: "list_context", args: {}, iteration: 3 },
  ];
  // Iterations 2 and 3 differ
  assert.equal(detectStagnation(log), false);
});
