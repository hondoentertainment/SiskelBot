/**
 * Unit tests for lib/tool-arg-repair.js — the inline tool-argument repair core.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRepairPrompt,
  repairToolArgs,
  toolArgRepairEnabled,
} from "../lib/tool-arg-repair.js";

test("buildRepairPrompt: includes tool name, args JSON, and hint", () => {
  const prompt = buildRepairPrompt(
    "search_context",
    { query: "x" },
    "query: Use at least 3 characters"
  );
  assert.match(prompt, /search_context/);
  assert.match(prompt, /"query": "x"/);
  assert.match(prompt, /Use at least 3 characters/);
  assert.match(prompt, /Return ONLY a JSON object/);
});

test("buildRepairPrompt: tolerates args that cannot be JSON-stringified", () => {
  const circular = {};
  circular.self = circular;
  const prompt = buildRepairPrompt("x", circular, "hint");
  // Should not throw; produces a string representation
  assert.equal(typeof prompt, "string");
  assert.match(prompt, /hint/);
});

test("buildRepairPrompt: uses placeholder when hint is empty", () => {
  const prompt = buildRepairPrompt("tool_x", { a: 1 }, "");
  assert.match(prompt, /no hint provided/);
});

test("repairToolArgs: happy path returns repairedArgs on valid JSON", async () => {
  const callFn = async () => JSON.stringify({ query: "a longer query" });
  const out = await repairToolArgs({
    toolName: "search_context",
    args: { query: "x" },
    repairHint: "too short",
    callFn,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.repairedArgs, { query: "a longer query" });
  assert.ok(out.rawResponse);
});

test("repairToolArgs: strips ```json fences", async () => {
  const callFn = async () => '```json\n{"url":"https://example.com"}\n```';
  const out = await repairToolArgs({
    toolName: "fetch_allowed_url",
    args: { url: "http://example.com" },
    repairHint: "must be https",
    callFn,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.repairedArgs, { url: "https://example.com" });
});

test("repairToolArgs: strips plain ``` fences without json tag", async () => {
  const callFn = async () => '```\n{"path":"/abs/x.txt"}\n```';
  const out = await repairToolArgs({
    toolName: "workspace_read_file",
    args: { path: "x.txt" },
    repairHint: "absolute",
    callFn,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.repairedArgs, { path: "/abs/x.txt" });
});

test("repairToolArgs: invalid JSON returns ok:false", async () => {
  const callFn = async () => "not json at all";
  const out = await repairToolArgs({
    toolName: "search_context",
    args: { query: "x" },
    repairHint: "hint",
    callFn,
  });
  assert.equal(out.ok, false);
  assert.ok(out.error);
  assert.equal(out.rawResponse, "not json at all");
});

test("repairToolArgs: array response is rejected (not a plain object)", async () => {
  const callFn = async () => "[1,2,3]";
  const out = await repairToolArgs({
    toolName: "x",
    args: {},
    repairHint: "h",
    callFn,
  });
  assert.equal(out.ok, false);
});

test("repairToolArgs: empty response returns ok:false", async () => {
  const callFn = async () => "";
  const out = await repairToolArgs({
    toolName: "x",
    args: {},
    repairHint: "h",
    callFn,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /empty/);
});

test("repairToolArgs: respects timeout", async () => {
  const callFn = () => new Promise((resolve) => setTimeout(() => resolve("{}"), 500));
  const out = await repairToolArgs({
    toolName: "x",
    args: {},
    repairHint: "h",
    callFn,
    timeoutMs: 30,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /timed out/);
});

test("repairToolArgs: callFn that throws returns ok:false", async () => {
  const callFn = async () => { throw new Error("backend exploded"); };
  const out = await repairToolArgs({
    toolName: "x",
    args: {},
    repairHint: "h",
    callFn,
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /backend exploded/);
});

test("repairToolArgs: missing callFn returns ok:false", async () => {
  const out = await repairToolArgs({
    toolName: "x",
    args: {},
    repairHint: "h",
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /callFn is required/);
});

test("toolArgRepairEnabled: defaults to false, flips with env", () => {
  const before = process.env.AGENT_TOOL_ARG_REPAIR;
  try {
    delete process.env.AGENT_TOOL_ARG_REPAIR;
    assert.equal(toolArgRepairEnabled(), false);
    process.env.AGENT_TOOL_ARG_REPAIR = "1";
    assert.equal(toolArgRepairEnabled(), true);
    process.env.AGENT_TOOL_ARG_REPAIR = "0";
    assert.equal(toolArgRepairEnabled(), false);
    process.env.AGENT_TOOL_ARG_REPAIR = "true"; // any non-"1" value is still false
    assert.equal(toolArgRepairEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.AGENT_TOOL_ARG_REPAIR;
    else process.env.AGENT_TOOL_ARG_REPAIR = before;
  }
});
