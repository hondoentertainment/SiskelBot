/**
 * Tests for lib/tool-stream.js -- SSE event emission for tool execution.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createToolStream } from "../lib/tool-stream.js";

/**
 * Create a fake Express response object that captures written SSE data.
 */
function mockRes() {
  const chunks = [];
  return {
    chunks,
    writableEnded: false,
    write(data) {
      chunks.push(data);
      return true;
    },
    /** Parse all emitted SSE events as JSON objects */
    getEvents() {
      return chunks
        .map((c) => {
          const m = c.match(/^data: (.+)\n\n$/);
          return m ? JSON.parse(m[1]) : null;
        })
        .filter(Boolean);
    },
  };
}

test("emitToolStart sends correct SSE format", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolStart("search_context", { query: "hello" });

  const events = res.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_start");
  assert.equal(events[0].name, "search_context");
  assert.deepStrictEqual(events[0].args, { query: "hello" });
  assert.equal(typeof events[0].timestamp, "number");
});

test("emitToolResult sends correct SSE format with duration", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolResult("list_context", { items: ["a", "b"] }, 42);

  const events = res.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_result");
  assert.equal(events[0].name, "list_context");
  assert.deepStrictEqual(events[0].result, { items: ["a", "b"] });
  assert.equal(events[0].durationMs, 42);
  assert.equal(typeof events[0].timestamp, "number");
});

test("emitToolError sends correct SSE format", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolError("execute_step", "Command timed out after 30s");

  const events = res.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_error");
  assert.equal(events[0].name, "execute_step");
  assert.equal(events[0].error, "Command timed out after 30s");
  assert.equal(typeof events[0].timestamp, "number");
});

test("emitToolProgress sends correct SSE format", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolProgress("search_context", { message: "Searching 42 documents...", percent: 50 });

  const events = res.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "tool_progress");
  assert.equal(events[0].name, "search_context");
  assert.equal(events[0].message, "Searching 42 documents...");
  assert.equal(events[0].percent, 50);
});

test("emitAgentThinking sends correct SSE format", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitAgentThinking("Planning next step...");

  const events = res.getEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agent_thinking");
  assert.equal(events[0].message, "Planning next step...");
});

test("full tool lifecycle: start -> result", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolStart("get_recipe", { name: "deploy" });
  ts.emitToolResult("get_recipe", { id: "r1", steps: [] }, 15);

  const events = res.getEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "tool_start");
  assert.equal(events[0].name, "get_recipe");
  assert.equal(events[1].type, "tool_result");
  assert.equal(events[1].name, "get_recipe");
  assert.equal(events[1].durationMs, 15);
});

test("full tool lifecycle: start -> error", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolStart("fetch_allowed_url", { url: "https://example.com" });
  ts.emitToolError("fetch_allowed_url", "Host not in allowlist");

  const events = res.getEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "tool_start");
  assert.equal(events[1].type, "tool_error");
  assert.equal(events[1].error, "Host not in allowlist");
});

test("null response returns no-op emitter", () => {
  const ts = createToolStream(null);
  // Should not throw
  ts.emitToolStart("foo", {});
  ts.emitToolProgress("foo", { percent: 50 });
  ts.emitToolResult("foo", {}, 0);
  ts.emitToolError("foo", "err");
  ts.emitAgentThinking("thinking");
});

test("ended response returns no-op emitter", () => {
  const res = mockRes();
  res.writableEnded = true;
  const ts = createToolStream(res);
  ts.emitToolStart("foo", {});
  assert.equal(res.chunks.length, 0);
});

test("emitToolError coerces non-string error", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolError("test_tool", { message: "oops" });

  const events = res.getEvents();
  assert.equal(events[0].error, "[object Object]");
});

test("emitToolProgress with no percent sends null", () => {
  const res = mockRes();
  const ts = createToolStream(res);
  ts.emitToolProgress("search_context", { message: "Working..." });

  const events = res.getEvents();
  assert.equal(events[0].percent, null);
  assert.equal(events[0].message, "Working...");
});

test("write failure is silently caught", () => {
  const res = {
    writableEnded: false,
    write() {
      throw new Error("Connection reset");
    },
  };
  const ts = createToolStream(res);
  // Should not throw
  ts.emitToolStart("foo", {});
  ts.emitToolResult("foo", {}, 0);
  ts.emitToolError("foo", "err");
  ts.emitAgentThinking("msg");
});
