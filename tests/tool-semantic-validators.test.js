/**
 * Tests for tool-semantic-validators: individual rules + registry + integration
 * with validateToolCall.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateSemantic,
  registerSemanticRules,
  clearSemanticRules,
  minStringLength,
  httpsUrlRequired,
  nonEmptyArray,
  absolutePath,
  rejectPlaceholder,
  semanticValidationEnabled,
} from "../lib/tool-semantic-validators.js";
import { validateToolCall } from "../lib/tool-validation.js";

test("minStringLength: passes when >= min", () => {
  const rule = minStringLength("q", 3);
  assert.equal(rule({ q: "abc" }), null);
  assert.equal(rule({ q: "longer" }), null);
});

test("minStringLength: fails when < min, returns hint", () => {
  const rule = minStringLength("q", 3);
  const out = rule({ q: "ab" });
  assert.ok(out);
  assert.equal(out[0].path, "q");
  assert.match(out[0].hint, /at least 3/);
});

test("minStringLength: ignores non-string and missing fields", () => {
  const rule = minStringLength("q", 3);
  assert.equal(rule({}), null);
  assert.equal(rule({ q: 42 }), null);
  assert.equal(rule({ q: null }), null);
});

test("httpsUrlRequired: passes for https://", () => {
  const rule = httpsUrlRequired("url");
  assert.equal(rule({ url: "https://example.com/path" }), null);
});

test("httpsUrlRequired: rejects http://", () => {
  const rule = httpsUrlRequired("url");
  const out = rule({ url: "http://example.com" });
  assert.ok(out);
  assert.match(out[0].hint, /https:\/\//);
});

test("httpsUrlRequired: rejects malformed URL", () => {
  const rule = httpsUrlRequired("url");
  const out = rule({ url: "not a url" });
  assert.ok(out);
  assert.match(out[0].hint, /full URL/);
});

test("httpsUrlRequired: ignores empty / missing", () => {
  const rule = httpsUrlRequired("url");
  assert.equal(rule({}), null);
  assert.equal(rule({ url: "" }), null);
});

test("nonEmptyArray: rejects empty array", () => {
  const rule = nonEmptyArray("items");
  const out = rule({ items: [] });
  assert.ok(out);
  assert.match(out[0].hint, /at least one/);
});

test("nonEmptyArray: passes for populated array and skips missing", () => {
  const rule = nonEmptyArray("items");
  assert.equal(rule({ items: ["a"] }), null);
  assert.equal(rule({}), null);
});

test("absolutePath: accepts POSIX absolute paths", () => {
  const rule = absolutePath("path");
  assert.equal(rule({ path: "/home/user/file.txt" }), null);
});

test("absolutePath: accepts Windows absolute paths", () => {
  const rule = absolutePath("path");
  assert.equal(rule({ path: "C:\\Users\\x\\file.txt" }), null);
  assert.equal(rule({ path: "D:/data/file.txt" }), null);
});

test("absolutePath: rejects relative paths", () => {
  const rule = absolutePath("path");
  const out = rule({ path: "./file.txt" });
  assert.ok(out);
  assert.match(out[0].hint, /absolute/);
});

test("rejectPlaceholder: flags obvious placeholder values", () => {
  const rule = rejectPlaceholder("title");
  assert.ok(rule({ title: "TODO" }));
  assert.ok(rule({ title: "your_value" }));
  assert.ok(rule({ title: "<replace-me>" }));
  assert.ok(rule({ title: "xxx" }));
  assert.ok(rule({ title: "..." }));
  assert.ok(rule({ title: "N/A" }));
});

test("rejectPlaceholder: passes for real values", () => {
  const rule = rejectPlaceholder("title");
  assert.equal(rule({ title: "Real title" }), null);
  assert.equal(rule({ title: "user guide v2" }), null);
});

test("validateSemantic: returns ok when no rules registered for a tool", () => {
  const r = validateSemantic("unknown_tool_xyz_test", { q: "ab" });
  assert.equal(r.ok, true);
  assert.equal(r.issues.length, 0);
});

test("validateSemantic: aggregates issues across rules", () => {
  const tool = `test_aggregate_${Date.now()}`;
  registerSemanticRules(tool, [
    minStringLength("q", 5),
    httpsUrlRequired("url"),
  ]);
  const r = validateSemantic(tool, { q: "hi", url: "http://x.com" });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 2);
  assert.match(r.repairHint, /q: Use at least 5/);
  assert.match(r.repairHint, /url: Use https/);
  clearSemanticRules(tool);
});

test("validateSemantic: rule exceptions are absorbed", () => {
  const tool = `test_throwing_${Date.now()}`;
  registerSemanticRules(tool, [() => { throw new Error("bad rule"); }]);
  const r = validateSemantic(tool, {});
  assert.equal(r.ok, true);
  clearSemanticRules(tool);
});

test("semanticValidationEnabled: default on, flips off via env", () => {
  const orig = process.env.TOOL_SEMANTIC_VALIDATION;
  delete process.env.TOOL_SEMANTIC_VALIDATION;
  assert.equal(semanticValidationEnabled(), true);
  process.env.TOOL_SEMANTIC_VALIDATION = "0";
  assert.equal(semanticValidationEnabled(), false);
  if (orig !== undefined) process.env.TOOL_SEMANTIC_VALIDATION = orig;
  else delete process.env.TOOL_SEMANTIC_VALIDATION;
});

/* ------------------------------ integration ------------------------------- */

test("integration: search_context with 2-char query is rejected by semantic layer", () => {
  const r = validateToolCall("search_context", { query: "ab" });
  assert.equal(r.valid, false);
  assert.match(r.repairHint, /at least 3/i);
});

test("integration: search_context with valid 3-char query passes", () => {
  const r = validateToolCall("search_context", { query: "abc" });
  assert.equal(r.valid, true);
});

test("integration: fetch_allowed_url with http:// URL is rejected", () => {
  const r = validateToolCall("fetch_allowed_url", { url: "http://example.com" });
  assert.equal(r.valid, false);
  assert.match(r.repairHint, /https:\/\//);
});

test("integration: fetch_allowed_url with https:// URL passes", () => {
  const r = validateToolCall("fetch_allowed_url", { url: "https://example.com/doc" });
  assert.equal(r.valid, true);
});

test("integration: search_context with placeholder query is rejected", () => {
  const r = validateToolCall("search_context", { query: "TODO" });
  assert.equal(r.valid, false);
  assert.match(r.repairHint, /placeholder/i);
});

test("integration: workspace_read_file with relative path is rejected", () => {
  const r = validateToolCall("workspace_read_file", { path: "./x.js" });
  assert.equal(r.valid, false);
  assert.match(r.repairHint, /absolute/i);
});

test("integration: workspace_read_file with absolute path passes", () => {
  const r = validateToolCall("workspace_read_file", { path: "/tmp/x.js" });
  assert.equal(r.valid, true);
});

test("integration: TOOL_SEMANTIC_VALIDATION=0 disables semantic checks", () => {
  const orig = process.env.TOOL_SEMANTIC_VALIDATION;
  process.env.TOOL_SEMANTIC_VALIDATION = "0";
  const r = validateToolCall("search_context", { query: "ab" });
  assert.equal(r.valid, true, "semantic check should be skipped when disabled");
  if (orig !== undefined) process.env.TOOL_SEMANTIC_VALIDATION = orig;
  else delete process.env.TOOL_SEMANTIC_VALIDATION;
});
