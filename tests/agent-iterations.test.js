/**
 * Phase 92: agentOptions.maxIterations clamped to MAX_AGENT_ITERATIONS ceiling
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentMaxIterations } from "../lib/agent-iterations.js";

const initialIgnore = process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT;

test.afterEach(() => {
  if (initialIgnore === undefined) delete process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT;
  else process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT = initialIgnore;
});

test("defaults to server ceiling when maxIterations omitted", () => {
  delete process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT;
  assert.equal(resolveAgentMaxIterations({}, undefined), 5);
  assert.equal(resolveAgentMaxIterations({}, "10"), 10);
});

test("clamps client value to ceiling", () => {
  delete process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT;
  assert.equal(resolveAgentMaxIterations({ maxIterations: 2 }, "10"), 2);
  assert.equal(resolveAgentMaxIterations({ maxIterations: 99 }, "10"), 10);
});

test("invalid client values fall back to ceiling", () => {
  delete process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT;
  assert.equal(resolveAgentMaxIterations({ maxIterations: 0 }, "8"), 8);
  assert.equal(resolveAgentMaxIterations({ maxIterations: -1 }, "8"), 8);
  assert.equal(resolveAgentMaxIterations({ maxIterations: "nope" }, "8"), 8);
});

test("AGENT_MAX_ITERATIONS_IGNORE_CLIENT ignores client", () => {
  process.env.AGENT_MAX_ITERATIONS_IGNORE_CLIENT = "1";
  assert.equal(resolveAgentMaxIterations({ maxIterations: 1 }, "10"), 10);
});
