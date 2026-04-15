/**
 * Tests for AGENT_CODEGEN_TOOLS gating and handlers.
 *
 * Covers:
 *   - Tool registration is gated on AGENT_CODEGEN_TOOLS=1
 *   - Schema shape is OpenAI-compatible
 *   - search_repo happy path (works against indexRepository-backed store)
 *   - search_repo / propose_patch error paths (bad input)
 *   - propose_patch is dry-run only and never writes to disk
 *   - run_tests requires BOTH flags AGENT_CODEGEN_TOOLS=1 AND WORKSPACE_FILE_TOOLS=1
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CODEGEN_NAMES = ["search_repo", "propose_patch", "run_tests"];

const TMP = mkdtempSync(join(tmpdir(), "siskel-codegen-"));
process.env.STORAGE_PATH = TMP;

const initialCodegen = process.env.AGENT_CODEGEN_TOOLS;
const initialWorkspace = process.env.WORKSPACE_FILE_TOOLS;
const initialAllow = process.env.AGENT_TOOLS_ALLOWLIST;

function restoreEnv() {
  if (initialCodegen === undefined) delete process.env.AGENT_CODEGEN_TOOLS;
  else process.env.AGENT_CODEGEN_TOOLS = initialCodegen;
  if (initialWorkspace === undefined) delete process.env.WORKSPACE_FILE_TOOLS;
  else process.env.WORKSPACE_FILE_TOOLS = initialWorkspace;
  if (initialAllow === undefined) delete process.env.AGENT_TOOLS_ALLOWLIST;
  else process.env.AGENT_TOOLS_ALLOWLIST = initialAllow;
}

test.afterEach(() => {
  restoreEnv();
});

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

async function importFresh(tag) {
  return import(`../lib/agent-tools.js?codegen-t=${Date.now()}-${tag}`);
}

test("codegen tools are NOT registered when AGENT_CODEGEN_TOOLS is unset", async () => {
  delete process.env.AGENT_CODEGEN_TOOLS;
  delete process.env.WORKSPACE_FILE_TOOLS;
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("unset");
  const names = mod.getRegisteredToolNames();
  for (const n of CODEGEN_NAMES) {
    assert.ok(!names.includes(n), `expected ${n} NOT in tool list when AGENT_CODEGEN_TOOLS unset`);
  }
});

test("codegen tools ARE registered with proper schemas when AGENT_CODEGEN_TOOLS=1", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  process.env.WORKSPACE_FILE_TOOLS = "1"; // to expose run_tests too
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("set");
  const schema = mod.getToolsSchema();
  const byName = new Map(schema.map((t) => [t.function?.name, t]));
  for (const n of CODEGEN_NAMES) {
    const tool = byName.get(n);
    assert.ok(tool, `expected ${n} in schema`);
    assert.equal(tool.type, "function");
    assert.equal(typeof tool.function.description, "string");
    assert.ok(tool.function.description.length > 10);
    assert.ok(tool.function.parameters && typeof tool.function.parameters === "object");
    assert.equal(tool.function.parameters.type, "object");
  }
  // search_repo requires query; propose_patch requires files + intent.
  assert.ok(byName.get("search_repo").function.parameters.required.includes("query"));
  assert.ok(byName.get("propose_patch").function.parameters.required.includes("files"));
  assert.ok(byName.get("propose_patch").function.parameters.required.includes("intent"));
});

test("run_tests is gated on WORKSPACE_FILE_TOOLS=1 in addition to AGENT_CODEGEN_TOOLS=1", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  delete process.env.WORKSPACE_FILE_TOOLS;
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("run-tests-ws-disabled");
  const names = mod.getRegisteredToolNames();
  assert.ok(names.includes("search_repo"));
  assert.ok(names.includes("propose_patch"));
  assert.ok(!names.includes("run_tests"), "run_tests must not register without WORKSPACE_FILE_TOOLS=1");
});

test("search_repo returns a hit against an indexed repo (happy path)", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  delete process.env.WORKSPACE_FILE_TOOLS;
  delete process.env.AGENT_TOOLS_ALLOWLIST;

  // Seed the repo-rag index for the "default" workspace (the tool hardcodes
  // workspace="default" when ctx.workspace is absent).
  const repoRag = await import(`../lib/repo-rag.js?t=${Date.now()}`);
  await repoRag._reset("default");
  await repoRag.indexRepository({
    workspaceId: "default",
    repoId: "repo-1",
    files: [
      { path: "src/alpha.js", content: "function alpha() { return 42; }" },
      { path: "src/beta.js", content: "function beta() { return 'hello'; }" },
    ],
  });

  const mod = await importFresh("search-ok");
  const r = await mod.runTool("search_repo", { query: "alpha", limit: 5 }, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, true);
  assert.ok(Array.isArray(out.hits));
  assert.ok(out.hits.length >= 1);
  assert.ok(out.hits.some((h) => h.path === "src/alpha.js"));
});

test("search_repo returns an error on empty query", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("search-bad");
  const r = await mod.runTool("search_repo", { query: "   " }, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /query is required/i);
});

test("search_repo refuses execution when AGENT_CODEGEN_TOOLS is unset (runtime gate)", async () => {
  delete process.env.AGENT_CODEGEN_TOOLS;
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("search-gated");
  const r = await mod.runTool("search_repo", { query: "alpha" }, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /AGENT_CODEGEN_TOOLS/i);
});

test("propose_patch returns a dry-run diff and does not mark the plan applied", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;

  // Reset the default workspace refactor store so we don't collide with
  // plans from prior test runs sharing the tmp STORAGE_PATH.
  const refactor = await import(`../lib/refactor-agent.js?t=${Date.now()}`);
  await refactor._reset("default");

  const mod = await importFresh("propose-ok");
  const r = await mod.runTool(
    "propose_patch",
    {
      files: [{ path: "a.js", content: "const foo = 1;" }],
      intent: { type: "rename", from: "foo", to: "bar" },
    },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.ok(out.planId);
  assert.equal(out.status, "planned");
  assert.equal(out.files[0].modified, "const bar = 1;");
  assert.equal(out.files[0].changes, 1);

  // Verify the plan remains in "planned" status (never applied by propose_patch).
  const stored = await refactor.getPlan(out.planId, "default");
  assert.equal(stored.status, "planned");
  assert.equal(stored.appliedAt, null);
});

test("propose_patch rejects an empty files array", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("propose-bad");
  const r = await mod.runTool(
    "propose_patch",
    { files: [], intent: { type: "rename", from: "x", to: "y" } },
    {},
  );
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /files array is required/i);
});

test("run_tests refuses when WORKSPACE_FILE_TOOLS is not set", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  delete process.env.WORKSPACE_FILE_TOOLS;
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("run-tests-gated");
  const r = await mod.runTool("run_tests", {}, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.match(String(out.error), /WORKSPACE_FILE_TOOLS/i);
});

test("run_tests refuses patterns containing unsafe shell metachars", async () => {
  process.env.AGENT_CODEGEN_TOOLS = "1";
  process.env.WORKSPACE_FILE_TOOLS = "1";
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await importFresh("run-tests-unsafe");
  const r = await mod.runTool("run_tests", { pattern: "foo; rm -rf /" }, {});
  const out = JSON.parse(r.content);
  assert.equal(out.ok, false);
  assert.equal(out.code, "UNSAFE_PATTERN");
});
