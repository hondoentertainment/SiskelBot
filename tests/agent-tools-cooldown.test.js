/**
 * Integration test: agent-tools.js filters out cooling-down tools.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "agent-tools-cooldown-"));
process.env.STORAGE_PATH = TMP;
delete process.env.AGENT_TOOLS_ALLOWLIST;

const cooldownMod = await import("../lib/tool-cooldown-store.js");
const agentTools = await import("../lib/agent-tools.js");

const { startCooldown, __resetAllCooldownsForTests } = cooldownMod;
const {
  getToolsSchema,
  getToolsForNames,
  filterToolsByWorkspaceAllowlist,
} = agentTools;

test.beforeEach(() => {
  __resetAllCooldownsForTests();
  delete process.env.TOOL_COOLDOWN_ENABLED;
});

test("getToolsSchema(ctx) drops cooling-down tool for the workspace", () => {
  const ws = "ws-cool-1";
  const full = getToolsSchema();
  assert.ok(full.some((t) => t.function.name === "list_context"));

  startCooldown(ws, "list_context", "terminal", 60_000);

  const filtered = getToolsSchema({ workspace: ws });
  assert.ok(!filtered.some((t) => t.function.name === "list_context"),
    "list_context should be filtered out while cooling down");
  assert.equal(filtered.length, full.length - 1);
});

test("getToolsSchema with no ctx returns unchanged schema (additive filter)", () => {
  const ws = "ws-no-ctx";
  startCooldown(ws, "list_context", "terminal", 60_000);
  const schema = getToolsSchema();
  assert.ok(schema.some((t) => t.function.name === "list_context"),
    "without ctx.workspace, cooldowns don't apply");
});

test("cooldown is workspace-isolated", () => {
  const wsA = "ws-iso-A";
  const wsB = "ws-iso-B";
  startCooldown(wsA, "search_context", "terminal", 60_000);

  const aTools = getToolsSchema({ workspace: wsA });
  assert.ok(!aTools.some((t) => t.function.name === "search_context"));

  const bTools = getToolsSchema({ workspace: wsB });
  assert.ok(bTools.some((t) => t.function.name === "search_context"),
    "unrelated workspace is unaffected");
});

test("TOOL_COOLDOWN_ENABLED=0 makes the filter a no-op", () => {
  const ws = "ws-disabled";
  startCooldown(ws, "list_context", "terminal", 60_000);
  process.env.TOOL_COOLDOWN_ENABLED = "0";
  try {
    const tools = getToolsSchema({ workspace: ws });
    assert.ok(tools.some((t) => t.function.name === "list_context"),
      "disabled cooldown must not filter");
  } finally {
    delete process.env.TOOL_COOLDOWN_ENABLED;
  }
});

test("getToolsForNames(names, ctx) also applies cooldown filter", () => {
  const ws = "ws-names";
  startCooldown(ws, "list_context", "terminal", 60_000);

  const withoutCtx = getToolsForNames(["list_context", "search_context"]);
  assert.equal(withoutCtx.length, 2, "no ctx: both returned");

  const withCtx = getToolsForNames(["list_context", "search_context"], { workspace: ws });
  assert.equal(withCtx.length, 1);
  assert.equal(withCtx[0].function.name, "search_context");
});

test("filterToolsByWorkspaceAllowlist(tools, names, ctx) chains allowlist + cooldown", () => {
  const ws = "ws-combined";
  startCooldown(ws, "list_context", "terminal", 60_000);

  const full = getToolsSchema();
  const byName = filterToolsByWorkspaceAllowlist(
    full,
    ["list_context", "search_context"],
    { workspace: ws }
  );
  // Allowlist narrows to 2, cooldown drops list_context, leaving 1.
  assert.equal(byName.length, 1);
  assert.equal(byName[0].function.name, "search_context");
});

test("filterToolsByWorkspaceAllowlist without ctx preserves legacy 2-arg behavior", () => {
  const ws = "ws-legacy";
  startCooldown(ws, "list_context", "terminal", 60_000);
  const full = getToolsSchema();
  const out = filterToolsByWorkspaceAllowlist(full, ["list_context", "search_context"]);
  // No ctx => cooldowns are ignored.
  assert.equal(out.length, 2);
});
