import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "failure-memory-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { failureMemoryEnabled, formatFailure, recordFailure } = await import("../lib/agent-failure-memory.js");
const { listMemories } = await import("../lib/agent-memory.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

test("failureMemoryEnabled: false by default", () => {
  const prev = process.env.AGENT_FAILURE_MEMORY;
  delete process.env.AGENT_FAILURE_MEMORY;
  try {
    assert.equal(failureMemoryEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_FAILURE_MEMORY = prev;
  }
});

test("formatFailure: includes kind, goal, tools, details", () => {
  const s = formatFailure({
    kind: "stagnation",
    userGoal: "find the thing",
    tools: ["search_context"],
    details: "looped 5x",
  });
  assert.match(s, /\[failure\]/);
  assert.match(s, /kind=stagnation/);
  assert.match(s, /find the thing/);
  assert.match(s, /search_context/);
  assert.match(s, /looped 5x/);
});

test("formatFailure: tolerates missing fields", () => {
  const s = formatFailure({ kind: "tool_failure" });
  assert.match(s, /kind=tool_failure/);
});

test("recordFailure: no-op when flag disabled", async () => {
  const prev = process.env.AGENT_FAILURE_MEMORY;
  delete process.env.AGENT_FAILURE_MEMORY;
  try {
    await recordFailure({
      userId: "user1",
      workspaceId: "ws1",
      kind: "stagnation",
      userGoal: "test",
    });
    const res = await listMemories("user1", "ws1", { limit: 50 });
    assert.equal(res.memories.length, 0);
  } finally {
    if (prev !== undefined) process.env.AGENT_FAILURE_MEMORY = prev;
  }
});

test("recordFailure: writes memory when flag enabled", async () => {
  const prev = process.env.AGENT_FAILURE_MEMORY;
  process.env.AGENT_FAILURE_MEMORY = "1";
  try {
    await recordFailure({
      userId: "user2",
      workspaceId: "ws2",
      kind: "stagnation",
      userGoal: "test goal",
      tools: ["search_context"],
      details: "looped",
    });
    const res = await listMemories("user2", "ws2", { limit: 50 });
    const failures = res.memories.filter((m) => typeof m.content === "string" && m.content.startsWith("[failure]"));
    assert.equal(failures.length, 1);
    assert.equal(failures[0].category, "observation");
  } finally {
    if (prev === undefined) delete process.env.AGENT_FAILURE_MEMORY;
    else process.env.AGENT_FAILURE_MEMORY = prev;
  }
});

test("recordFailure: never throws on invalid input", async () => {
  const prev = process.env.AGENT_FAILURE_MEMORY;
  process.env.AGENT_FAILURE_MEMORY = "1";
  try {
    await recordFailure({});
    await recordFailure(null);
    await recordFailure({ userId: "", workspaceId: "" });
    // Should have completed without exceptions
    assert.ok(true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_FAILURE_MEMORY;
    else process.env.AGENT_FAILURE_MEMORY = prev;
  }
});
