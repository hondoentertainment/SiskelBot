/**
 * Integration tests for validateToolCallWithRepair: combines the semantic
 * validators in tool-validation.js with the repair core in tool-arg-repair.js.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateToolCall,
  validateToolCallWithRepair,
} from "../lib/tool-validation.js";

test("validateToolCallWithRepair: without repairFn matches validateToolCall for valid args", async () => {
  const args = { query: "a sensible query" };
  const sync = validateToolCall("search_context", args);
  const asyncResult = await validateToolCallWithRepair("search_context", args);
  assert.equal(asyncResult.valid, sync.valid);
  assert.deepEqual(asyncResult.errors, sync.errors);
  assert.equal(asyncResult.repairedArgs, undefined);
});

test("validateToolCallWithRepair: without repairFn matches validateToolCall for invalid args", async () => {
  const args = { query: "x" }; // too short for semantic validator
  const sync = validateToolCall("search_context", args);
  assert.equal(sync.valid, false);
  const asyncResult = await validateToolCallWithRepair("search_context", args);
  assert.equal(asyncResult.valid, false);
  assert.deepEqual(asyncResult.errors, sync.errors);
  assert.equal(asyncResult.repairHint, sync.repairHint);
});

test("validateToolCallWithRepair: search_context short query -> repaired to long query", async () => {
  const repairFn = async ({ toolName, args, repairHint }) => {
    assert.equal(toolName, "search_context");
    assert.equal(args.query, "x");
    assert.ok(repairHint.length > 0);
    return { ok: true, repairedArgs: { query: "user asked about the search flow" } };
  };
  const out = await validateToolCallWithRepair(
    "search_context",
    { query: "x" },
    { repairFn }
  );
  assert.equal(out.valid, true);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.repairedArgs, { query: "user asked about the search flow" });
});

test("validateToolCallWithRepair: fetch_allowed_url http -> repaired to https", async () => {
  const repairFn = async () => ({
    ok: true,
    repairedArgs: { url: "https://example.com/path" },
  });
  const out = await validateToolCallWithRepair(
    "fetch_allowed_url",
    { url: "http://example.com/path" },
    { repairFn }
  );
  assert.equal(out.valid, true);
  assert.deepEqual(out.repairedArgs, { url: "https://example.com/path" });
});

test("validateToolCallWithRepair: workspace_read_file relative -> repaired to absolute", async () => {
  const repairFn = async () => ({ ok: true, repairedArgs: { path: "/workspace/notes.md" } });
  const out = await validateToolCallWithRepair(
    "workspace_read_file",
    { path: "notes.md" },
    { repairFn }
  );
  assert.equal(out.valid, true);
  assert.deepEqual(out.repairedArgs, { path: "/workspace/notes.md" });
});

test("validateToolCallWithRepair: repairFn that returns still-invalid args falls back to original failure", async () => {
  const repairFn = async () => ({ ok: true, repairedArgs: { query: "y" } }); // still too short
  const out = await validateToolCallWithRepair(
    "search_context",
    { query: "x" },
    { repairFn }
  );
  assert.equal(out.valid, false);
  assert.ok(out.errors.length > 0);
  assert.equal(out.repairedArgs, undefined);
});

test("validateToolCallWithRepair: repairFn ok:false falls back to original failure", async () => {
  const repairFn = async () => ({ ok: false, error: "gave up" });
  const out = await validateToolCallWithRepair(
    "search_context",
    { query: "x" },
    { repairFn }
  );
  assert.equal(out.valid, false);
  assert.equal(out.repairedArgs, undefined);
});

test("validateToolCallWithRepair: repairFn that throws falls back to original failure", async () => {
  const repairFn = async () => { throw new Error("boom"); };
  const out = await validateToolCallWithRepair(
    "search_context",
    { query: "x" },
    { repairFn }
  );
  assert.equal(out.valid, false);
  assert.equal(out.repairedArgs, undefined);
});

test("validateToolCallWithRepair: repairFn returning array is rejected", async () => {
  const repairFn = async () => ({ ok: true, repairedArgs: ["a", "b"] });
  const out = await validateToolCallWithRepair(
    "search_context",
    { query: "x" },
    { repairFn }
  );
  assert.equal(out.valid, false);
});

test("validateToolCallWithRepair: does not invoke repairFn when parseError is set", async () => {
  let calls = 0;
  const repairFn = async () => { calls++; return { ok: true, repairedArgs: { query: "fine query" } }; };
  const out = await validateToolCallWithRepair(
    "search_context",
    {},
    { repairFn, parseError: "Unexpected token" }
  );
  assert.equal(out.valid, false);
  assert.equal(calls, 0);
  assert.match(out.repairHint, /JSON/);
});

test("validateToolCallWithRepair: does not invoke repairFn when initial validation passes", async () => {
  let calls = 0;
  const repairFn = async () => { calls++; return { ok: true, repairedArgs: {} }; };
  const out = await validateToolCallWithRepair(
    "search_context",
    { query: "a reasonable query" },
    { repairFn }
  );
  assert.equal(out.valid, true);
  assert.equal(calls, 0);
});
