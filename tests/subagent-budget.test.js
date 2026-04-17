/**
 * Tests for lib/subagent-budget.js — budget enforcement for subagents.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBudget } from "../lib/subagent-budget.js";
import { runAgentLoop } from "../lib/agent-loop.js";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Unit tests for createBudget
// ---------------------------------------------------------------------------

test("maxIterations: 3 iterations OK, 4th triggers exceeded", () => {
  const b = createBudget({ maxIterations: 3 });
  b.recordIteration();
  assert.deepStrictEqual(b.check(), { exceeded: false });
  b.recordIteration();
  assert.deepStrictEqual(b.check(), { exceeded: false });
  b.recordIteration();
  // 3rd iteration recorded — now at limit
  const result = b.check();
  assert.equal(result.exceeded, true);
  assert.equal(result.reason, "iterations_exceeded");
  assert.equal(result.detail.iterations, 3);
  assert.equal(result.detail.maxIterations, 3);
});

test("maxCostUsd: two 0.005 charges exceed 0.01 cap", () => {
  const b = createBudget({ maxCostUsd: 0.01 });
  b.recordCostUsd(0.005);
  assert.deepStrictEqual(b.check(), { exceeded: false });
  b.recordCostUsd(0.005);
  const result = b.check();
  assert.equal(result.exceeded, true);
  assert.equal(result.reason, "cost_exceeded");
  assert.equal(result.detail.costUsd, 0.01);
});

test("maxWallTimeMs: exceeded after sleeping past the limit", async () => {
  const b = createBudget({ maxWallTimeMs: 50 });
  assert.deepStrictEqual(b.check(), { exceeded: false });
  await sleep(60);
  const result = b.check();
  assert.equal(result.exceeded, true);
  assert.equal(result.reason, "wall_time_exceeded");
  assert.ok(result.detail.wallTimeMs >= 50);
});

test("maxToolCalls: 2 OK, 3rd triggers exceeded", () => {
  const b = createBudget({ maxToolCalls: 2 });
  b.recordToolCall();
  b.recordToolCall();
  // At limit
  const result = b.check();
  assert.equal(result.exceeded, true);
  assert.equal(result.reason, "tool_calls_exceeded");
  assert.equal(result.detail.toolCalls, 2);
  assert.equal(result.detail.maxToolCalls, 2);
});

test("null/undefined/zero limits: never exceeded", () => {
  const b = createBudget({ maxIterations: null, maxCostUsd: undefined, maxWallTimeMs: 0, maxToolCalls: null });
  for (let i = 0; i < 100; i++) {
    b.recordIteration();
    b.recordToolCall();
    b.recordCostUsd(100);
  }
  assert.deepStrictEqual(b.check(), { exceeded: false });
});

test("empty limits object: never exceeded", () => {
  const b = createBudget({});
  b.recordIteration();
  b.recordToolCall();
  b.recordCostUsd(999);
  assert.deepStrictEqual(b.check(), { exceeded: false });
});

test("summary() returns correct counts and exceeded state", () => {
  const b = createBudget({ maxIterations: 5, maxCostUsd: 1.0, maxToolCalls: 10 });
  b.recordIteration();
  b.recordIteration();
  b.recordToolCall();
  b.recordToolCall();
  b.recordToolCall();
  b.recordCostUsd(0.25);
  b.recordCostUsd(0.10);

  const s = b.summary();
  assert.equal(s.iterations, 2);
  assert.equal(s.toolCalls, 3);
  assert.ok(Math.abs(s.costUsd - 0.35) < 1e-9);
  assert.equal(s.exceeded, false);
  assert.ok(s.wallTimeMs >= 0);
  assert.equal(s.reason, undefined);
});

test("summary() includes reason when exceeded", () => {
  const b = createBudget({ maxIterations: 1 });
  b.recordIteration();
  const s = b.summary();
  assert.equal(s.exceeded, true);
  assert.equal(s.reason, "iterations_exceeded");
});

test("recordCostUsd ignores non-positive and non-number values", () => {
  const b = createBudget({ maxCostUsd: 1.0 });
  b.recordCostUsd(-5);
  b.recordCostUsd(0);
  b.recordCostUsd(NaN);
  b.recordCostUsd("hello");
  assert.equal(b.summary().costUsd, 0);
});

test("startTime is set to roughly Date.now() at creation", () => {
  const before = Date.now();
  const b = createBudget({});
  const after = Date.now();
  assert.ok(b.startTime >= before);
  assert.ok(b.startTime <= after);
});

// ---------------------------------------------------------------------------
// Integration test: runAgentLoop with budget maxIterations=1
// ---------------------------------------------------------------------------

test("runAgentLoop stops after 1 iteration with budget_exceeded", async () => {
  const budget = createBudget({ maxIterations: 1 });

  // Backend always returns a tool call — without budget the loop would iterate
  // until maxAgentIterations. With budget maxIterations=1, the budget check
  // fires at the top of iteration 1 (after recordIteration) before the LLM
  // call, so zero backend calls are made and the loop exits immediately.
  let backendCallCount = 0;
  const backendFetch = async () => {
    backendCallCount++;
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_budget_test",
                  type: "function",
                  function: { name: "list_context", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    };
  };

  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "Test budget" }],
      agentOptions: {
        workspace: "default",
        allowExecution: false,
        budget,
      },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);
  assert.equal(result.stopReason, "budget_exceeded");
  assert.ok(result.content.includes("budget exceeded"));
  assert.ok(result.budgetSummary);
  assert.equal(result.budgetSummary.exceeded, true);
  assert.equal(result.budgetSummary.reason, "iterations_exceeded");
  // Budget check fires at the top of iteration 1 (recordIteration increments
  // to 1, which meets the cap of 1), so only 1 recordIteration call happens.
  assert.equal(result.budgetSummary.iterations, 1);
  // No backend call should have been made since budget tripped immediately.
  assert.equal(backendCallCount, 0);
});

test("runAgentLoop with budget maxIterations=2: runs 1 tool iteration then stops", async () => {
  const budget = createBudget({ maxIterations: 2 });

  // With maxIterations=2, iteration 1 succeeds (budget records 1, check passes),
  // the LLM returns a tool call, tools run, then iteration 2 starts: budget
  // records 2, check fires (2 >= 2).
  let round = 0;
  const backendFetch = async () => {
    round++;
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${round}`,
                  type: "function",
                  function: { name: "list_context", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    };
  };

  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "Test budget iter 2" }],
      agentOptions: {
        workspace: "default",
        allowExecution: false,
        budget,
      },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runAgentLoop(req, res, config, "test-model", null, backendFetch);
  assert.equal(result.stopReason, "budget_exceeded");
  assert.equal(result.budgetSummary.iterations, 2);
  assert.equal(result.budgetSummary.reason, "iterations_exceeded");
  // One LLM call should have been made (iteration 1 passed the check).
  assert.equal(round, 1);
  // Tool calls should have been recorded for the one tool call in iteration 1.
  assert.equal(result.budgetSummary.toolCalls, 1);
});
