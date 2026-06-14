import test from "node:test";
import assert from "node:assert/strict";
import { runEvalSet, checkCriteria, parseSseEvalResponse } from "../lib/eval-runner.js";

test("checkCriteria passes when no criteria specified", () => {
  const result = checkCriteria({}, "some output");
  assert.equal(result.pass, true);
});

test("checkCriteria passes with expectedContains match", () => {
  const result = checkCriteria({ expectedContains: "hello" }, "say hello world");
  assert.equal(result.pass, true);
});

test("checkCriteria fails with expectedContains mismatch", () => {
  const result = checkCriteria({ expectedContains: "goodbye" }, "say hello world");
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("goodbye"));
});

test("checkCriteria passes with expectedPattern match", () => {
  const result = checkCriteria({ expectedPattern: "\\d+" }, "there are 42 items");
  assert.equal(result.pass, true);
});

test("checkCriteria fails with expectedPattern mismatch", () => {
  const result = checkCriteria({ expectedPattern: "^\\d+$" }, "no numbers here");
  assert.equal(result.pass, false);
});

test("checkCriteria handles invalid regex in expectedPattern", () => {
  const result = checkCriteria({ expectedPattern: "[invalid" }, "test");
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("Invalid regex"));
});

test("checkCriteria passes with expectedJson key present", () => {
  const result = checkCriteria(
    { expectedJson: ["name"] },
    "unused",
    { name: "Alice", age: 30 }
  );
  assert.equal(result.pass, true);
});

test("checkCriteria fails with expectedJson key missing", () => {
  const result = checkCriteria(
    { expectedJson: ["missingKey"] },
    "unused",
    { name: "Alice" }
  );
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes("missingKey"));
});

test("parseSseEvalResponse extracts content from SSE data", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":" world"},"index":0}]}',
    "data: [DONE]",
  ].join("\n");
  const result = parseSseEvalResponse(raw);
  assert.equal(result.content, "Hello world");
  assert.equal(result.agentActivity, null);
});

test("parseSseEvalResponse extracts agent_activity", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"test"},"index":0}]}',
    'data: {"type":"agent_activity","tools":["search"]}',
    "data: [DONE]",
  ].join("\n");
  const result = parseSseEvalResponse(raw);
  assert.equal(result.content, "test");
  assert.ok(result.agentActivity);
  assert.equal(result.agentActivity.type, "agent_activity");
});

test("parseSseEvalResponse handles empty input", () => {
  const result = parseSseEvalResponse("");
  assert.equal(result.content, "");
  assert.equal(result.agentActivity, null);
});

test("runEvalSet with mock API runs chat cases", async () => {
  const mockFetch = async (_url, _opts) => {
    return {
      ok: true,
      headers: {
        get: () => "application/json",
        forEach: () => {},
      },
      text: async () => JSON.stringify({
        choices: [{ message: { content: "Hello from mock" } }],
      }),
    };
  };

  const evalSet = {
    id: "test-set",
    name: "Test",
    cases: [
      { id: "case-1", prompt: "Say hello", expectedContains: "Hello" },
    ],
  };

  const result = await runEvalSet(evalSet, {
    baseUrl: "http://localhost:9999",
    fetchFn: mockFetch,
  });

  assert.equal(result.total, 1);
  assert.equal(result.passed, 1);
  assert.equal(result.results[0].pass, true);
  assert.ok(result.durationMs >= 0);
});

test("runEvalSet skips cases with skip=true", async () => {
  const evalSet = {
    id: "skip-set",
    name: "Skip Test",
    cases: [
      { id: "skip-1", prompt: "ignored", skip: true, skipReason: "Not ready" },
    ],
  };

  const result = await runEvalSet(evalSet, { baseUrl: "http://localhost:9999" });
  assert.equal(result.total, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.passed, 0);
  assert.equal(result.results[0].skipped, true);
  assert.equal(result.results[0].reason, "Not ready");
});

test("runEvalSet handles API errors gracefully", async () => {
  const mockFetch = async () => {
    return {
      ok: false,
      status: 500,
      headers: { get: () => "application/json", forEach: () => {} },
      text: async () => "Internal Server Error",
    };
  };

  const evalSet = {
    id: "error-set",
    name: "Error Test",
    cases: [
      { id: "err-1", prompt: "test" },
    ],
  };

  const result = await runEvalSet(evalSet, {
    baseUrl: "http://localhost:9999",
    fetchFn: mockFetch,
  });

  assert.equal(result.total, 1);
  assert.equal(result.passed, 0);
  assert.ok(result.results[0].error);
});
