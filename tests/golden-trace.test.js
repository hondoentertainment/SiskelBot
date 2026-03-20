/**
 * Phase 56: Golden-trace eval criteria (offline).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkGoldenTrace, normalizeTrace } from "../lib/eval-golden-trace.js";

test("normalizeTrace maps tool/arguments", () => {
  const n = normalizeTrace([{ tool: "list_context", arguments: {} }]);
  assert.equal(n[0].name, "list_context");
});

test("expectedToolSequence order must match", () => {
  const pass = checkGoldenTrace(
    { expectedToolSequence: ["list_context", "search_context"] },
    [{ name: "list_context" }, { name: "search_context", arguments: { query: "a" } }]
  );
  assert.equal(pass.pass, true);
});

test("expectedToolSequence fails on wrong order", () => {
  const r = checkGoldenTrace(
    { expectedToolSequence: ["search_context", "list_context"] },
    [{ name: "list_context" }, { name: "search_context", arguments: { query: "a" } }]
  );
  assert.equal(r.pass, false);
});

test("expectedToolNames multiset", () => {
  const r = checkGoldenTrace(
    { expectedToolNames: ["search_context", "search_context"] },
    [
      { name: "search_context", arguments: { query: "a" } },
      { name: "search_context", arguments: { query: "b" } },
    ]
  );
  assert.equal(r.pass, true);
});

test("expectedToolCalls requiredArgKeys", () => {
  const ok = checkGoldenTrace(
    { expectedToolCalls: [{ name: "search_context", requiredArgKeys: ["query"] }] },
    [{ name: "search_context", arguments: { query: "hi" } }]
  );
  assert.equal(ok.pass, true);
  const bad = checkGoldenTrace(
    { expectedToolCalls: [{ name: "search_context", requiredArgKeys: ["query"] }] },
    [{ name: "search_context", arguments: {} }]
  );
  assert.equal(bad.pass, false);
});
