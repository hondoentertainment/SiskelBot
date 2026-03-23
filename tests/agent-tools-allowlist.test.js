/**
 * Phase 89: AGENT_TOOLS_ALLOWLIST
 */
import test from "node:test";
import assert from "node:assert/strict";

const initial = process.env.AGENT_TOOLS_ALLOWLIST;

test.afterEach(() => {
  if (initial === undefined) delete process.env.AGENT_TOOLS_ALLOWLIST;
  else process.env.AGENT_TOOLS_ALLOWLIST = initial;
});

test("getToolsSchema returns subset when allowlist set", async () => {
  process.env.AGENT_TOOLS_ALLOWLIST = "list_context,search_context";
  const mod = await import("../lib/agent-tools.js");
  const sch = mod.getToolsSchema();
  assert.ok(sch.length >= 1);
  assert.ok(sch.every((t) => t.function?.name === "list_context" || t.function?.name === "search_context"));
  assert.equal(sch.find((t) => t.function.name === "execute_step"), undefined);
});

test("intersectClientToolsWithAllowlist keeps only allowed names", async () => {
  process.env.AGENT_TOOLS_ALLOWLIST = "list_context";
  const mod = await import("../lib/agent-tools.js");
  const fake = [
    { type: "function", function: { name: "list_context", parameters: {} } },
    { type: "function", function: { name: "execute_step", parameters: {} } },
  ];
  const x = mod.intersectClientToolsWithAllowlist(fake);
  assert.equal(x.length, 1);
  assert.equal(x[0].function.name, "list_context");
});

test("filterToolsByWorkspaceAllowlist intersects server tool list", async () => {
  delete process.env.AGENT_TOOLS_ALLOWLIST;
  const mod = await import("../lib/agent-tools.js");
  const full = mod.getToolsSchema();
  const one = mod.filterToolsByWorkspaceAllowlist(full, ["list_context"]);
  assert.ok(one.length >= 1);
  assert.ok(one.every((t) => t.function.name === "list_context"));
  assert.equal(mod.filterToolsByWorkspaceAllowlist(full, []).length, full.length);
});
