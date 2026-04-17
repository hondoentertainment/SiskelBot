/**
 * Tests for the spawn_subagent tool and lib/spawn-subagent.js implementation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolate storage for agent-session creation
const dir = mkdtempSync(join(tmpdir(), "spawn-subagent-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { spawnSubagent, resolveProfilePrompt } = await import(
  "../lib/spawn-subagent.js"
);
const { getAgentSession } = await import("../lib/agent-session.js");
const {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
  __resetAgentRunStreamForTests();
});

/**
 * Helper: build a mock runAgentLoop that returns a canned text response.
 * Records calls for assertion.
 */
function makeMockRunAgentLoop(responseContent = "Child done.", opts = {}) {
  const calls = [];
  async function mockRunAgentLoop(req, res, config, model, streamOptions, backendFetch) {
    calls.push({ req, res, config, model, streamOptions, backendFetch });
    if (opts.throwError) {
      throw new Error(opts.throwError);
    }
    return {
      content: responseContent,
      iteration: opts.iterations || 2,
      toolCalls: opts.toolCalls || [{ name: "search_context", args: {}, iteration: 1, durationMs: 10, ok: true }],
      runId: "child-run-123",
      stopReason: "model_finished",
    };
  }
  return { mockRunAgentLoop, calls };
}

function mockBuildProxyConfig(model) {
  return { baseUrl: "http://mock", path: "/v1/chat/completions", headers: {} };
}

async function mockBackendFetch() {
  return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
}

// ---------- Test 1: basic spawn with stubbed backend ----------
test("spawnSubagent: creates child session and returns ok:true with result", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("Research complete.");

  const result = await spawnSubagent({
    goal: "Summarize the knowledge base",
    profile: "researcher",
    workspace: "default",
    userId: "testuser",
    depth: 0,
    parentTools: [
      { type: "function", function: { name: "search_context", parameters: {} } },
      { type: "function", function: { name: "spawn_subagent", parameters: {} } },
    ],
    parentModel: "test-model",
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, "Research complete.");
  assert.ok(result.childSessionId);
  assert.equal(result.iterations, 2);
  assert.equal(result.toolCallCount, 1);

  // Verify child session was created
  const session = await getAgentSession(result.childSessionId);
  assert.ok(session);
  assert.equal(session.workspace, "default");
  assert.equal(session.ownerStorageUserId, "testuser");

  // Verify runAgentLoop was called
  assert.equal(calls.length, 1);
  const childReq = calls[0].req;
  assert.equal(childReq.body.model, "test-model");
  assert.ok(childReq.body.messages[0].content.includes("research agent"));
});

// ---------- Test 2: depth limit ----------
test("spawnSubagent: depth limit rejects with SUBAGENT_DEPTH_EXCEEDED", async () => {
  const { mockRunAgentLoop } = makeMockRunAgentLoop();

  const result = await spawnSubagent({
    goal: "Too deep",
    depth: 3,
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "SUBAGENT_DEPTH_EXCEEDED");
  assert.ok(result.error.includes("depth"));
});

test("spawnSubagent: depth=2 is allowed, depth=3 is rejected", async () => {
  const { mockRunAgentLoop } = makeMockRunAgentLoop("ok");

  const okResult = await spawnSubagent({
    goal: "Allowed depth",
    depth: 2,
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });
  assert.equal(okResult.ok, true);

  const failResult = await spawnSubagent({
    goal: "Too deep",
    depth: 3,
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });
  assert.equal(failResult.ok, false);
  assert.equal(failResult.code, "SUBAGENT_DEPTH_EXCEEDED");
});

// ---------- Test 3: spawn_subagent excluded from child tools ----------
test("spawnSubagent: spawn_subagent is excluded from child tool list", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("done");

  await spawnSubagent({
    goal: "Test tool filtering",
    parentTools: [
      { type: "function", function: { name: "search_context", parameters: {} } },
      { type: "function", function: { name: "spawn_subagent", parameters: {} } },
      { type: "function", function: { name: "list_context", parameters: {} } },
    ],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  assert.equal(calls.length, 1);
  const childTools = calls[0].req.body.tools;
  const names = childTools.map((t) => t.function.name);
  assert.ok(!names.includes("spawn_subagent"), "spawn_subagent must not be in child tools");
  assert.ok(names.includes("search_context"));
  assert.ok(names.includes("list_context"));
});

test("spawnSubagent: toolAllowlist filters child tools but still excludes spawn_subagent", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("done");

  await spawnSubagent({
    goal: "Test allowlist filtering",
    toolAllowlist: ["search_context", "spawn_subagent"],
    parentTools: [
      { type: "function", function: { name: "search_context", parameters: {} } },
      { type: "function", function: { name: "spawn_subagent", parameters: {} } },
      { type: "function", function: { name: "list_context", parameters: {} } },
    ],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  const childTools = calls[0].req.body.tools;
  const names = childTools.map((t) => t.function.name);
  assert.ok(!names.includes("spawn_subagent"));
  assert.ok(names.includes("search_context"));
  assert.ok(!names.includes("list_context"), "list_context not in allowlist");
});

// ---------- Test 4: profile-based system prompts ----------
test("resolveProfilePrompt: each profile returns a distinct prompt", () => {
  const profiles = ["researcher", "executor", "synthesizer", "code_writer", "reviewer", "default"];
  const prompts = profiles.map(resolveProfilePrompt);

  // All should be non-empty strings
  for (const p of prompts) {
    assert.ok(typeof p === "string" && p.length > 0);
  }

  // Each should be unique
  const unique = new Set(prompts);
  assert.equal(unique.size, profiles.length, "All profiles should produce unique prompts");
});

test("resolveProfilePrompt: unknown profile falls back to default", () => {
  const p = resolveProfilePrompt("nonexistent_profile");
  const d = resolveProfilePrompt("default");
  assert.equal(p, d);
});

test("spawnSubagent: profile system prompt is used in child messages", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("done");

  await spawnSubagent({
    goal: "Review this code",
    profile: "reviewer",
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  const messages = calls[0].req.body.messages;
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("review agent"));
});

// ---------- Test 5: error in child returns ok:false ----------
test("spawnSubagent: error in child loop returns ok:false without throwing", async () => {
  const { mockRunAgentLoop } = makeMockRunAgentLoop("", { throwError: "Backend exploded" });

  const result = await spawnSubagent({
    goal: "This will fail",
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  assert.equal(result.ok, false);
  assert.ok(result.error.includes("Backend exploded"));
  assert.ok(result.childSessionId, "childSessionId should still be present");
});

// ---------- Test 6: events published on parent emitter ----------
test("spawnSubagent: publishes subagent.spawned and subagent.done on parent session emitter", async () => {
  const { mockRunAgentLoop } = makeMockRunAgentLoop("Child result");
  const parentSessionId = "parent-sess-" + Date.now();

  // Create the emitter before spawning so events are captured
  const emitter = getAgentRunEmitter(parentSessionId);
  const events = [];
  emitter.on("event", (ev) => events.push(ev));

  await spawnSubagent({
    goal: "Delegated task",
    profile: "executor",
    parentSessionId,
    parentRunId: "parent-run-1",
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  const spawned = events.find((e) => e.type === "subagent.spawned");
  assert.ok(spawned, "subagent.spawned event should be published");
  assert.equal(spawned.payload.goal, "Delegated task");
  assert.equal(spawned.payload.profile, "executor");
  assert.ok(spawned.payload.childSessionId);

  const done = events.find((e) => e.type === "subagent.done");
  assert.ok(done, "subagent.done event should be published");
  assert.ok(done.payload.result.includes("Child result"));
  assert.equal(done.payload.childSessionId, spawned.payload.childSessionId);
  assert.equal(done.payload.iterations, 2);

  // Clean up
  emitter.removeAllListeners();
});

test("spawnSubagent: publishes subagent.done with error when child fails", async () => {
  const { mockRunAgentLoop } = makeMockRunAgentLoop("", { throwError: "crash" });
  const parentSessionId = "parent-err-" + Date.now();

  const emitter = getAgentRunEmitter(parentSessionId);
  const events = [];
  emitter.on("event", (ev) => events.push(ev));

  await spawnSubagent({
    goal: "Failing task",
    parentSessionId,
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  const done = events.find((e) => e.type === "subagent.done");
  assert.ok(done);
  assert.ok(done.payload.error.includes("crash"));

  emitter.removeAllListeners();
});

// ---------- Test 7: context is appended to user message ----------
test("spawnSubagent: context is appended to user message", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("done");

  await spawnSubagent({
    goal: "Do the thing",
    context: "Here is extra info.",
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  const userMsg = calls[0].req.body.messages[1];
  assert.equal(userMsg.role, "user");
  assert.ok(userMsg.content.includes("Do the thing"));
  assert.ok(userMsg.content.includes("Additional context:"));
  assert.ok(userMsg.content.includes("Here is extra info."));
});

// ---------- Test 8: model override ----------
test("spawnSubagent: model override is passed to child", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("done");

  await spawnSubagent({
    goal: "Use specific model",
    model: "gpt-4o",
    parentModel: "gpt-3.5-turbo",
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  assert.equal(calls[0].req.body.model, "gpt-4o");
  assert.equal(calls[0].model, "gpt-4o");
});

test("spawnSubagent: inherits parent model when no model override", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("done");

  await spawnSubagent({
    goal: "Inherit model",
    parentModel: "gpt-3.5-turbo",
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  assert.equal(calls[0].req.body.model, "gpt-3.5-turbo");
});

// ---------- Test 9: depth is incremented for child ----------
test("spawnSubagent: passes depth + 1 to child agentOptions", async () => {
  const { mockRunAgentLoop, calls } = makeMockRunAgentLoop("done");

  await spawnSubagent({
    goal: "Check depth",
    depth: 1,
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  assert.equal(calls[0].req.body.agentOptions.depth, 2);
});

// ---------- Test 10: planSummary includes parent session id ----------
test("spawnSubagent: child session planSummary includes parent session id", async () => {
  const { mockRunAgentLoop } = makeMockRunAgentLoop("done");

  const result = await spawnSubagent({
    goal: "Linked task",
    parentSessionId: "parent-abc",
    parentTools: [],
    runAgentLoop: mockRunAgentLoop,
    backendFetch: mockBackendFetch,
    buildProxyConfig: mockBuildProxyConfig,
  });

  const session = await getAgentSession(result.childSessionId);
  assert.ok(session.planSummary.includes("[subagent of parent-abc]"));
  assert.ok(session.planSummary.includes("Linked task"));
});
