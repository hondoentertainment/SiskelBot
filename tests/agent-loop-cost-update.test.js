/**
 * Asserts that lib/agent-loop.js publishes cost.update events on the per-session
 * Agent Run emitter after each chat-completion call, with cumulative totals,
 * and cleans up its per-run accumulator on the terminal `done` event.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-cost-"));
const prevStoragePath = process.env.STORAGE_PATH;
const prevModelCosts = process.env.MODEL_COSTS;
process.env.STORAGE_PATH = dir;

const { createAgentSession, linkRunToAgentSession } = await import(
  "../lib/agent-session.js"
);
const {
  runAgentLoop,
  __getRunCostAccumulatorForTests,
  __resetRunCostAccumulatorsForTests,
} = await import("../lib/agent-loop.js");
const {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");
const { parseCostConfig } = await import("../lib/smart-router.js");

test.after(() => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  parseCostConfig("");
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  if (prevModelCosts === undefined) delete process.env.MODEL_COSTS;
  else process.env.MODEL_COSTS = prevModelCosts;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a stub fetch that returns a sequence of canned chat-completion
 * responses, advancing one per call.
 */
function makeStubFetch(responses) {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: true,
      json: async () => next,
    };
  };
}

function baseReq(presetSessionId) {
  return {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      agentOptions: {
        workspace: "default",
        allowExecution: false,
        ...(presetSessionId ? { sessionId: presetSessionId } : {}),
      },
    },
  };
}

const baseRes = () => ({ headersSent: false, setHeader() {} });
const baseConfig = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

test("emits cost.update with totalUsd + tokens after chat completion", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  // 0.002 USD per 1k tokens for this model.
  parseCostConfig("test-model:0.002");

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "cost-update-1",
  });
  const presetRunId = "run-cost-1-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  /** @type {Array<{type:string,payload:any}>} */
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const backendFetch = makeStubFetch([
    {
      choices: [
        { message: { role: "assistant", content: "Done." } },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
  ]);

  await runAgentLoop(
    baseReq(session.id),
    baseRes(),
    baseConfig,
    "test-model",
    { presetRunId },
    backendFetch,
  );

  const costEvents = observed.filter((e) => e.type === "cost.update");
  assert.equal(costEvents.length, 1, "expected exactly one cost.update event");
  const p = costEvents[0].payload;
  assert.equal(p.tokens.prompt, 100);
  assert.equal(p.tokens.completion, 50);
  assert.equal(p.tokens.total, 150);
  assert.equal(p.model, "test-model");
  // 150 tokens * 0.002 / 1000 = 0.0003
  assert.ok(Math.abs(p.totalUsd - 0.0003) < 1e-9, `totalUsd=${p.totalUsd}`);
  assert.equal(p.iteration, 1);
  assert.equal(p.runId, presetRunId);
});

test("two completions yield monotonic cumulative totalUsd", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  parseCostConfig("test-model:0.002");

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "cost-update-2",
  });
  const presetRunId = "run-cost-2-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  // First response: triggers a tool call so the loop iterates again.
  const responses = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "tc1",
                type: "function",
                function: { name: "list_workspace_memory", arguments: "{}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
    {
      choices: [
        { message: { role: "assistant", content: "All set." } },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
    },
  ];

  await runAgentLoop(
    baseReq(session.id),
    baseRes(),
    baseConfig,
    "test-model",
    { presetRunId },
    makeStubFetch(responses),
  );

  const costEvents = observed.filter((e) => e.type === "cost.update");
  assert.ok(
    costEvents.length >= 2,
    `expected >= 2 cost.update events, got ${costEvents.length}`,
  );
  // Monotonic, cumulative.
  assert.ok(
    costEvents[1].payload.totalUsd >= costEvents[0].payload.totalUsd,
    `expected cumulative totalUsd, got ${costEvents[0].payload.totalUsd} -> ${costEvents[1].payload.totalUsd}`,
  );
  // First event: 120 tokens * 0.002 / 1000 = 0.00024
  // Second event: cumulative 350 tokens -> 0.0007
  assert.ok(Math.abs(costEvents[0].payload.totalUsd - 0.00024) < 1e-9);
  assert.ok(Math.abs(costEvents[1].payload.totalUsd - 0.0007) < 1e-9);
  // Cumulative tokens too.
  assert.equal(costEvents[1].payload.tokens.total, 350);
  assert.equal(costEvents[1].payload.tokens.prompt, 300);
  assert.equal(costEvents[1].payload.tokens.completion, 50);
});

test("done event cleans up the per-run accumulator", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  parseCostConfig("test-model:0.002");

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "cost-update-cleanup",
  });
  const presetRunId = "run-cost-cleanup-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const backendFetch = makeStubFetch([
    {
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);

  await runAgentLoop(
    baseReq(session.id),
    baseRes(),
    baseConfig,
    "test-model",
    { presetRunId },
    backendFetch,
  );

  // After the loop completes (which emits `done`), the accumulator entry for
  // this runId should have been removed.
  assert.equal(__getRunCostAccumulatorForTests(presetRunId), null);
});

test("missing sessionId — no cost.update emitted, no throw", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  parseCostConfig("test-model:0.002");

  // Spin up an emitter for *some* session; this run is NOT linked to it,
  // and we never expose its session id to the loop, so no events should fire.
  const sessionId = "sess-not-linked-to-run";
  const emitter = getAgentRunEmitter(sessionId);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const presetRunId = "run-no-session-" + Date.now();
  // Intentionally NOT linked to any agent session; getSessionIdForRun returns
  // null, so liveSessionId stays empty and no events publish.
  const backendFetch = makeStubFetch([
    {
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);

  // Build a request with NO agentOptions.sessionId to force resolution path.
  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };

  await assert.doesNotReject(async () => {
    await runAgentLoop(
      req,
      baseRes(),
      baseConfig,
      "test-model",
      { presetRunId },
      backendFetch,
    );
  });

  const costEvents = observed.filter((e) => e.type === "cost.update");
  assert.equal(costEvents.length, 0);
});

test("missing usage tokens — emits cost.update with zero tokens and zero totalUsd", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  // No cost configured for this model at all.
  parseCostConfig("");

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "cost-update-no-usage",
  });
  const presetRunId = "run-cost-no-usage-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const backendFetch = makeStubFetch([
    {
      choices: [{ message: { role: "assistant", content: "ok" } }],
      // no `usage` field
    },
  ]);

  await runAgentLoop(
    baseReq(session.id),
    baseRes(),
    baseConfig,
    "test-model",
    { presetRunId },
    backendFetch,
  );

  const costEvents = observed.filter((e) => e.type === "cost.update");
  assert.equal(costEvents.length, 1);
  assert.equal(costEvents[0].payload.totalUsd, 0);
  assert.equal(costEvents[0].payload.tokens.prompt, 0);
  assert.equal(costEvents[0].payload.tokens.completion, 0);
  assert.equal(costEvents[0].payload.tokens.total, 0);
});
