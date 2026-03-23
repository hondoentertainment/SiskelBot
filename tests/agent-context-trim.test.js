import test from "node:test";
import assert from "node:assert/strict";
import { truncateToolResultContent } from "../lib/agent-context-trim.js";

test("truncateToolResultContent leaves short strings", () => {
  assert.equal(truncateToolResultContent("hi", 100), "hi");
});

test("truncateToolResultContent adds suffix when over max", () => {
  const s = "x".repeat(200);
  const out = truncateToolResultContent(s, 80);
  assert.ok(out.length < s.length);
  assert.ok(out.includes("truncated"));
});
