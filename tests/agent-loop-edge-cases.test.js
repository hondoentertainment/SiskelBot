/**
 * Edge-case coverage for lib/agent-loop.js that existing tests don't pin:
 *
 *  1. Backend returns a completion shell with no choices and no usage.
 *     The loop must terminate cleanly with stopReason === "no_message"
 *     and publish a terminal `done` event.
 *
 *  2. The LLM asks to call a tool that isn't registered. The loop's
 *     validation pass (lib/tool-validation.js KNOWN_TOOLS) short-circuits
 *     the unknown tool, records it with ok:false + validationError:true,
 *     injects a _tool_validation_error into messages, and the loop
 *     iterates. The `default:` branch in runToolCore now throws an
 *     assertion error (unreachable if validation is enabled).
 *
 *  3. Iteration cap is reached while the model keeps requesting tools. The
 *     loop must exit with stopReason === "max_iterations" and emit a
 *     terminal `done` event carrying that reason.
 *
 *  4. A tool that fails (ok:false payload) mid-loop. The loop must feed
 *     the error content into the next turn's messages and terminate
 *     cleanly without leaking an `error` SSE event. This also documents
 *     the stronger invariant that runTool's try/catch (lib/agent-tools.js)
 *     absorbs any thrown exception into an ok:false content — so even if
 *     a tool's Promise rejects, neither an `error` event nor an unhandled
 *     rejection should leak out of runAgentLoop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-edge-"));
const prevStoragePath = process.env.STORAGE_PATH;
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

test.after(() => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

/** Build a stub fetch that returns a queue of canned completions. */
function queueFetch(responses) {
  let i = 0;
  return async () => {
    const body = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, json: async () => body };
  };
}

function makeReq(sessionId, extraAgentOpts = {}) {
  return {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      agentOptions: {
        workspace: "default",
        allowExecution: false,
        sessionId,
        ...extraAgentOpts,
      },
    },
  };
}

const makeRes = () => ({ headersSent: false, setHeader() {} });
const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

test("empty completion (no choices, no usage) terminates cleanly with stopReason='no_message'", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "edge-empty-completion",
  });
  const presetRunId = "run-edge-empty-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const backendFetch = queueFetch([{} /* no choices, no usage */]);

  const result = await runAgentLoop(
    makeReq(session.id),
    makeRes(),
    config,
    "test-model",
    { presetRunId },
    backendFetch,
  );

  assert.equal(result.stopReason, "no_message");
  assert.equal(result.content, "(No response from model)");
  assert.equal(result.iteration, 1);

  const doneEvents = observed.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "expected exactly one done event");
  assert.equal(doneEvents[0].payload.reason, "no_message");

  // Cost accumulator should be cleaned up on terminal done.
  assert.equal(__getRunCostAccumulatorForTests(presetRunId), null);
});

test("unknown tool name: runTool returns error content, loop continues to next iteration, terminates normally", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "edge-unknown-tool",
  });
  const presetRunId = "run-edge-unknown-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  // Iteration 1: model asks for a tool that doesn't exist.
  // Iteration 2: model returns final text.
  const backendFetch = queueFetch([
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc-unknown",
                type: "function",
                function: {
                  name: "definitely_not_a_real_tool_xyz",
                  arguments: "{}",
                },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [{ message: { role: "assistant", content: "Recovered." } }],
    },
  ]);

  const result = await runAgentLoop(
    makeReq(session.id),
    makeRes(),
    config,
    "test-model",
    { presetRunId },
    backendFetch,
  );

  assert.equal(result.stopReason, "model_finished");
  assert.equal(result.content, "Recovered.");
  // The unknown-tool call is recorded in the log. Behavior: the loop's
  // validation pass (lib/tool-validation.js KNOWN_TOOLS) short-circuits the
  // unknown tool, records it with validationError:true + ok:false, and
  // injects a `_tool_validation_error` payload into messages. runToolCore's
  // default branch (now an assertion throw) is never reached through this path.
  const unknownEntry = result.toolCalls.find(
    (t) => t.name === "definitely_not_a_real_tool_xyz",
  );
  assert.ok(unknownEntry, "expected unknown tool to appear in toolCalls log");
  assert.equal(unknownEntry.ok, false, "unknown tool should be logged ok:false via validation");
  assert.equal(unknownEntry.validationError, true);
  assert.equal(unknownEntry.durationMs, 0);

  // Loop terminated normally with a done event carrying the model_finished reason.
  const doneEvents = observed.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].payload.reason, "model_finished");
});

test("iteration cap reached: stopReason='max_iterations' + terminal done event carries that reason", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "edge-max-iters",
  });
  const presetRunId = "run-edge-maxiter-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  // Every iteration asks for a tool call (with *different* arguments so
  // stagnation detection doesn't short-circuit before the iteration cap),
  // so the loop never gets a model_finished signal and will run until the
  // cap.
  const makeToolCallResponse = (id, limit) => ({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: {
                name: "list_workspace_memory",
                arguments: JSON.stringify({ limit }),
              },
            },
          ],
        },
      },
    ],
  });
  const backendFetch = queueFetch([
    makeToolCallResponse("tc-1", 3),
    makeToolCallResponse("tc-2", 7),
    // Defensive: further calls (shouldn't happen) also return tool calls.
    makeToolCallResponse("tc-overflow", 11),
  ]);

  const result = await runAgentLoop(
    makeReq(session.id, { maxIterations: 2 }),
    makeRes(),
    config,
    "test-model",
    { presetRunId },
    backendFetch,
  );

  assert.equal(result.stopReason, "max_iterations");
  assert.equal(result.iteration, 2);
  assert.match(
    String(result.content),
    /reached max iterations/i,
    `expected placeholder 'reached max iterations' copy, got ${JSON.stringify(result.content)}`,
  );

  const doneEvents = observed.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1, "expected exactly one done event");
  assert.equal(doneEvents[0].payload.reason, "max_iterations");

  // Status.change should have fired at least once per iteration.
  const statusChanges = observed.filter((e) => e.type === "status.change");
  assert.ok(
    statusChanges.length >= 2,
    `expected >= 2 status.change events, got ${statusChanges.length}`,
  );

  // Cost accumulator cleaned up after the terminal `done`.
  assert.equal(__getRunCostAccumulatorForTests(presetRunId), null);
});

test("tool that fails (ok:false) mid-loop: error is absorbed into tool-result content; loop continues and emits no `error` event", async () => {
  __resetAgentRunStreamForTests();
  __resetRunCostAccumulatorsForTests();

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "edge-throwing-tool",
  });
  const presetRunId = "run-edge-throw-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  const emitter = getAgentRunEmitter(session.id);
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  // Use fetch_allowed_url with no URL — that path returns an ok:false
  // payload ("url is required"). If a tool ever *threw* instead, runTool's
  // try/catch would wrap it into ok:false content with the same downstream
  // effect on the loop. Either way the loop's second turn sees the error
  // content in messages and returns final text.
  const backendFetch = queueFetch([
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tc-throw",
                type: "function",
                function: {
                  name: "fetch_allowed_url",
                  arguments: JSON.stringify({ url: "" }),
                },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [{ message: { role: "assistant", content: "Handled." } }],
    },
  ]);

  // If runAgentLoop let a rejection leak, this would reject.
  const result = await runAgentLoop(
    makeReq(session.id),
    makeRes(),
    config,
    "test-model",
    { presetRunId },
    backendFetch,
  );

  assert.equal(result.stopReason, "model_finished");
  assert.equal(result.content, "Handled.");
  // The throwing tool is captured in toolCalls.
  const throwEntry = result.toolCalls.find(
    (t) => t.name === "fetch_allowed_url",
  );
  assert.ok(throwEntry, "expected fetch_allowed_url in toolCalls log");
  // Arg-validation rejects the empty url before runToolCore is reached, so
  // the log entry is ok:false with validationError:true and durationMs:0.
  // If a tool threw an error bypassing validation, runTool's try/catch now
  // correctly sets ok:false on the wrapper object (bug #2 fix), so the log
  // entry would also record ok:false.
  assert.equal(throwEntry.ok, false);
  assert.equal(throwEntry.validationError, true);
  // Loop published a terminal done event even though the tool failed.
  const doneEvents = observed.filter((e) => e.type === "done");
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].payload.reason, "model_finished");
  // No `error` events should have been emitted for a swallowed tool throw.
  const errorEvents = observed.filter((e) => e.type === "error");
  assert.equal(
    errorEvents.length,
    0,
    `expected no 'error' events for a swallowed tool throw, got ${JSON.stringify(errorEvents)}`,
  );
});
