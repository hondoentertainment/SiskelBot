/**
 * Phase 55: Tool argument validation (pre-execution).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateToolCall } from "../lib/tool-validation.js";

test("search_context requires non-empty query", () => {
  const v = validateToolCall("search_context", {});
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("query")));
});

test("execute_step requires action string", () => {
  const v = validateToolCall("execute_step", { payload: {} });
  assert.equal(v.valid, false);
});

test("list_context accepts empty object", () => {
  const v = validateToolCall("list_context", {});
  assert.equal(v.valid, true);
});

test("unknown tool fails", () => {
  const v = validateToolCall("bad_tool", {});
  assert.equal(v.valid, false);
});

test("parseError surfaces JSON hint", () => {
  const v = validateToolCall("search_context", {}, { parseError: "Unexpected token" });
  assert.equal(v.valid, false);
  assert.ok(v.repairHint.includes("JSON"));
});
