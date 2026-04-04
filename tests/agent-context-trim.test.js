import test from "node:test";
import assert from "node:assert/strict";
import {
  truncateToolResultContent,
  applyToolMessageBudget,
} from "../lib/agent-context-trim.js";

test("truncateToolResultContent respects max", () => {
  const long = "x".repeat(500);
  assert.equal(truncateToolResultContent(long, 0).length, 500);
  const t = truncateToolResultContent(long, 200);
  assert.ok(t.length < long.length);
  assert.ok(t.includes("truncated"));
});

test("applyToolMessageBudget drops oldest tool rounds", () => {
  const assistantCall = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "1", type: "function", function: { name: "a", arguments: "{}" } }],
  };
  const tool1 = { role: "tool", tool_call_id: "1", content: "first" };
  const assistantCall2 = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "2", type: "function", function: { name: "b", arguments: "{}" } }],
  };
  const tool2 = { role: "tool", tool_call_id: "2", content: "second" };
  const base = [{ role: "user", content: "hi" }];
  const messages = [...base, assistantCall, tool1, assistantCall2, tool2];
  const trimmed = applyToolMessageBudget(messages, 1, 0);
  const toolMsgs = trimmed.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 1);
  assert.equal(toolMsgs[0].content, "second");
});

test("applyToolMessageBudget no-op when limits disabled", () => {
  const m = [{ role: "user", content: "x" }];
  assert.deepEqual(applyToolMessageBudget(m, 0, 0), m);
});
