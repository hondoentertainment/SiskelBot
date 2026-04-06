import test from "node:test";
import assert from "node:assert/strict";

test.before(() => {
  process.env.STORAGE_PATH = "/tmp/ws-memory-test-" + Date.now();
});

await test("appendWorkspaceMemoryFact returns error for empty fact", async () => {
  const { appendWorkspaceMemoryFact } = await import("../lib/workspace-memory-tool.js");
  const result = await appendWorkspaceMemoryFact("user1", "ws1", "");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("empty"));
});

await test("appendWorkspaceMemoryFact returns error for whitespace-only fact", async () => {
  const { appendWorkspaceMemoryFact } = await import("../lib/workspace-memory-tool.js");
  const result = await appendWorkspaceMemoryFact("user1", "ws1", "   ");
  assert.equal(result.ok, false);
});

await test("appendWorkspaceMemoryFact stores a fact successfully", async () => {
  const { appendWorkspaceMemoryFact } = await import("../lib/workspace-memory-tool.js");
  const result = await appendWorkspaceMemoryFact("user1", "memws", "The project uses Node.js 18");
  assert.equal(result.ok, true);
  assert.ok(typeof result.count === "number");
  assert.ok(result.count >= 1);
});

await test("appendWorkspaceMemoryFact increments count on subsequent calls", async () => {
  const { appendWorkspaceMemoryFact } = await import("../lib/workspace-memory-tool.js");
  const r1 = await appendWorkspaceMemoryFact("user1", "memws", "Fact one");
  const r2 = await appendWorkspaceMemoryFact("user1", "memws", "Fact two");
  assert.ok(r2.count > r1.count);
});

await test("stored facts persist in workspace agent settings", async () => {
  const { loadWorkspaceAgentSettings } = await import("../lib/workspace-agent-settings.js");
  const settings = await loadWorkspaceAgentSettings("user1", "memws");
  assert.ok(Array.isArray(settings.memorySnippets));
  const agentMemorySnippets = settings.memorySnippets.filter(s => s.includes("[agent-memory]"));
  assert.ok(agentMemorySnippets.length >= 2);
});
