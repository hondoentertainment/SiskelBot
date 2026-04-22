/**
 * Cover error branches in runTool that are easy to exercise via direct
 * calls: missing required args, disabled feature flags, unknown tool names.
 * Each test hits one or more branches that were previously uncovered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-tools-err-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { runTool } = await import("../lib/agent-tools.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

function parse(result) {
  return JSON.parse(result.content);
}

test("runTool: fetch_allowed_url without url returns error", async () => {
  const r = await runTool("fetch_allowed_url", {}, {});
  const p = parse(r);
  assert.equal(p.ok, false);
  assert.match(p.error, /url is required/);
});

test("runTool: chain_tools without steps array returns error", async () => {
  const r = await runTool("chain_tools", {}, {});
  const p = parse(r);
  assert.equal(p.ok, false);
  assert.match(p.error, /steps array is required/);
});

test("runTool: chain_tools with empty steps array returns error", async () => {
  const r = await runTool("chain_tools", { steps: [] }, {});
  const p = parse(r);
  assert.equal(p.ok, false);
  assert.match(p.error, /steps array is required/);
});

test("runTool: remember_workspace_fact without fact returns error", async () => {
  const r = await runTool("remember_workspace_fact", {}, {});
  const p = parse(r);
  assert.equal(p.ok, false);
  assert.match(p.error, /fact is required/);
});

test("runTool: workspace_read_file disabled when WORKSPACE_FILE_TOOLS unset", async () => {
  const prev = process.env.WORKSPACE_FILE_TOOLS;
  delete process.env.WORKSPACE_FILE_TOOLS;
  try {
    const r = await runTool("workspace_read_file", { path: "/tmp/x" }, {});
    const p = parse(r);
    assert.equal(p.ok, false);
    assert.match(p.error, /WORKSPACE_FILE_TOOLS is not enabled/);
  } finally {
    if (prev === undefined) delete process.env.WORKSPACE_FILE_TOOLS;
    else process.env.WORKSPACE_FILE_TOOLS = prev;
  }
});

test("runTool: search_context without query returns error", async () => {
  const r = await runTool("search_context", {}, { workspace: "default", workspaceUserId: "anonymous" });
  const p = parse(r);
  assert.match(p.error || "", /query is required/);
});

test("runTool: semantic_search_context without query returns error", async () => {
  const r = await runTool("semantic_search_context", {}, { workspace: "default", workspaceUserId: "anonymous" });
  const p = parse(r);
  assert.match(p.error || "", /query is required/);
});

test("runTool: get_context_document without id returns error", async () => {
  const r = await runTool("get_context_document", {}, { workspace: "default", workspaceUserId: "anonymous" });
  const p = parse(r);
  assert.match(p.error || "", /id is required/);
});

test("runTool: get_recipe without name returns error", async () => {
  const r = await runTool("get_recipe", {}, { workspace: "default", workspaceUserId: "anonymous" });
  const p = parse(r);
  assert.match(p.error || "", /name is required/);
});

test("runTool: execute_step without action returns validation error", async () => {
  const r = await runTool("execute_step", { action: "" }, { allowExecution: true });
  const p = parse(r);
  assert.equal(p.ok, false);
  assert.match(p.error, /action is required/);
});

test("runTool: update_agent_session_plan without session returns NO_ACTIVE_SESSION", async () => {
  const r = await runTool(
    "update_agent_session_plan",
    { planSummary: "p1" },
    { workspace: "default", workspaceUserId: "anonymous" },
  );
  const p = parse(r);
  assert.equal(p.ok, false);
  assert.equal(p.code, "NO_ACTIVE_SESSION");
});

test("runTool: unknown tool returns Unknown tool error", async () => {
  const r = await runTool("totally_not_a_tool", {}, {});
  const p = parse(r);
  assert.match(p.error, /Unknown tool/);
});
