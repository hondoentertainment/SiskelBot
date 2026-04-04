import test from "node:test";
import assert from "node:assert/strict";
import { truncateToolResultContent, getAgentToolResultMaxChars } from "../lib/agent-context-trim.js";

test("truncateToolResultContent leaves short strings", () => {
  assert.equal(truncateToolResultContent("hi", 100), "hi");
});

test("truncateToolResultContent adds suffix when over max", () => {
  const s = "x".repeat(200);
  const out = truncateToolResultContent(s, 80);
  assert.ok(out.length < s.length);
  assert.ok(out.includes("truncated"));
});

test("truncateToolResultContent respects exact max chars boundary", () => {
  const s = "a".repeat(500);
  // Exactly at limit should pass through
  assert.equal(truncateToolResultContent(s, 500), s);
  // Below limit should truncate (budget = max(64, n - suffix_len))
  const out = truncateToolResultContent(s, 200);
  assert.ok(out.length < s.length);
  assert.ok(out.includes("truncated"));
});

test("truncateToolResultContent passes through when maxChars is 0 (disabled)", () => {
  const s = "x".repeat(1000);
  assert.equal(truncateToolResultContent(s, 0), s);
});

test("truncateToolResultContent passes through when maxChars is negative", () => {
  const s = "hello world";
  assert.equal(truncateToolResultContent(s, -10), s);
});

test("truncateToolResultContent passes through when maxChars is NaN", () => {
  const s = "hello world";
  assert.equal(truncateToolResultContent(s, NaN), s);
});

test("truncateToolResultContent converts non-string content to string", () => {
  assert.equal(truncateToolResultContent(null, 0), "");
  assert.equal(truncateToolResultContent(undefined, 0), "");
  assert.equal(truncateToolResultContent(42, 0), "42");
});

test("getAgentToolResultMaxChars returns 0 when env not set", (t) => {
  const orig = process.env.AGENT_TOOL_RESULT_MAX_CHARS;
  delete process.env.AGENT_TOOL_RESULT_MAX_CHARS;
  t.after(() => {
    if (orig !== undefined) process.env.AGENT_TOOL_RESULT_MAX_CHARS = orig;
    else delete process.env.AGENT_TOOL_RESULT_MAX_CHARS;
  });
  assert.equal(getAgentToolResultMaxChars(), 0);
});

test("getAgentToolResultMaxChars returns value from env", (t) => {
  const orig = process.env.AGENT_TOOL_RESULT_MAX_CHARS;
  process.env.AGENT_TOOL_RESULT_MAX_CHARS = "5000";
  t.after(() => {
    if (orig !== undefined) process.env.AGENT_TOOL_RESULT_MAX_CHARS = orig;
    else delete process.env.AGENT_TOOL_RESULT_MAX_CHARS;
  });
  assert.equal(getAgentToolResultMaxChars(), 5000);
});

test("getAgentToolResultMaxChars caps at 2_000_000", (t) => {
  const orig = process.env.AGENT_TOOL_RESULT_MAX_CHARS;
  process.env.AGENT_TOOL_RESULT_MAX_CHARS = "999999999";
  t.after(() => {
    if (orig !== undefined) process.env.AGENT_TOOL_RESULT_MAX_CHARS = orig;
    else delete process.env.AGENT_TOOL_RESULT_MAX_CHARS;
  });
  assert.equal(getAgentToolResultMaxChars(), 2_000_000);
});
