/**
 * Asserts that lib/agent-loop.js has a top-level error boundary:
 *   - exceptions from the backend propagate to the caller unchanged
 *   - an `error` event is published on the session emitter (with message)
 *   - a terminal `done` event with `reason:"error"` follows so the SSE stream
 *     closes cleanly
 *   - the per-run cost accumulator is cleaned up via the finally clause even
 *     when the error fires mid-run (after some `cost.update` events)
 *   - when no sessionId is resolvable, the boundary still cleans up and
 *     rethrows without emitting events
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-error-boundary-"));
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
 * Build a stub fetch that returns a sequence of canned responses. Each entry
 * may either be a plain completion JSON object or { __throw: Error } / a
 * function. Throwing entries raise from the fetch itself (i.e. before
 * response.ok is checked).
 */
function makeStubFetch(responses) {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next && next.__throw) throw next.__throw;
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

test("backend throws on first completion: error+done events fire, error rethrown", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  parseCostConfig("test-model:0.002");

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "error-boundary-1",
  });
  const presetRunId = "run-err-1-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  /** @type {Array<{type:string,payload:any}>} */
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const boom = Object.assign(new Error("backend exploded"), { code: "EBOOM" });
  const backendFetch = makeStubFetch([{ __throw: boom }]);

  await assert.rejects(
    () =>
      runAgentLoop(
        baseReq(session.id),
        baseRes(),
        baseConfig,
        "test-model",
        { presetRunId },
        backendFetch,
      ),
    (err) => err === boom,
  );

  const errorEvents = observed.filter((e) => e.type === "error");
  assert.equal(errorEvents.length, 1, "exactly one error event");
  assert.equal(errorEvents[0].payload.message, "backend exploded");
  assert.equal(errorEvents[0].payload.code, "EBOOM");
  assert.equal(errorEvents[0].payload.runId, presetRunId);
  // iteration should reflect the in-progress iteration (1)
  assert.equal(errorEvents[0].payload.iteration, 1);

  // A terminal `done` event with reason:"error" should follow.
  const doneEvents = observed.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "exactly one done event");
  assert.equal(doneEvents[0].payload.reason, "error");

  // error must precede done in the stream.
  const errIdx = observed.findIndex((e) => e.type === "error");
  const doneIdx = observed.findIndex((e) => e.type === "done");
  assert.ok(errIdx >= 0 && doneIdx > errIdx, "error precedes done");

  // Accumulator entry should have been disposed by the finally clause.
  assert.equal(__getRunCostAccumulatorForTests(presetRunId), null);
});

test("throws mid-run after a cost.update: accumulator cleaned, error+done fired", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  parseCostConfig("test-model:0.002");

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "error-boundary-2",
  });
  const presetRunId = "run-err-2-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  // First call: succeeds and requests a tool call so loop iterates again.
  // Second call: throws.
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
    { __throw: new Error("second call failed") },
  ];

  await assert.rejects(
    () =>
      runAgentLoop(
        baseReq(session.id),
        baseRes(),
        baseConfig,
        "test-model",
        { presetRunId },
        makeStubFetch(responses),
      ),
    /second call failed/,
  );

  // One cost.update should have fired before the error (from the first call).
  const costEvents = observed.filter((e) => e.type === "cost.update");
  assert.equal(costEvents.length, 1, "one cost.update before the error");
  assert.equal(costEvents[0].payload.tokens.total, 120);

  const errorEvents = observed.filter((e) => e.type === "error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].payload.message, "second call failed");
  assert.equal(errorEvents[0].payload.runId, presetRunId);
  // The iteration counter should be 2 when the second backend call throws.
  assert.equal(errorEvents[0].payload.iteration, 2);

  const doneEvents = observed.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].payload.reason, "error");

  // Accumulator entry disposed even though the run failed.
  assert.equal(__getRunCostAccumulatorForTests(presetRunId), null);
});

test("no sessionId: error propagates, no events emitted, accumulator cleaned", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  parseCostConfig("test-model:0.002");

  // Spin up an emitter for some unrelated session; this run is not linked
  // to it, and no sessionId is threaded into runAgentLoop, so no events
  // should land on this emitter.
  const sessionId = "sess-not-linked-to-err-run";
  const emitter = getAgentRunEmitter(sessionId);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const presetRunId = "run-err-no-session-" + Date.now();
  const boom = new Error("lonely boom");
  const backendFetch = makeStubFetch([{ __throw: boom }]);

  // Build a request with NO agentOptions.sessionId so liveSessionId resolution
  // (via getSessionIdForRun) returns nothing.
  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };

  await assert.rejects(
    () =>
      runAgentLoop(
        req,
        baseRes(),
        baseConfig,
        "test-model",
        { presetRunId },
        backendFetch,
      ),
    (err) => err === boom,
  );

  // No events should have fired on the unrelated emitter.
  assert.equal(observed.length, 0);
  // And even without a session, the accumulator is still cleaned via finally.
  assert.equal(__getRunCostAccumulatorForTests(presetRunId), null);
});
