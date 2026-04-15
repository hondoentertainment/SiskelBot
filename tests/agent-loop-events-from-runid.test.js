/**
 * Tests that runAgentLoop and executeAgentToolBatch publish SSE events on a
 * session's emitter even when the caller supplies only a runId (no
 * sessionId), now that the runId → sessionId reverse index is in place.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-evt-"));
const prevStoragePath = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { createAgentSession, linkRunToAgentSession } = await import(
  "../lib/agent-session.js"
);
const { runAgentLoop } = await import("../lib/agent-loop.js");
const { executeAgentToolBatch } = await import(
  "../lib/agent-loop-execute-tools.js"
);
const {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");
const { createPolicyState } = await import("../lib/agent-policy.js");

test.after(() => {
  __resetAgentRunStreamForTests();
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  rmSync(dir, { recursive: true, force: true });
});

test("runAgentLoop publishes status.change/done events when only runId is known", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "runid-only",
  });
  const presetRunId = "run-agent-loop-from-runid-" + Date.now();
  await linkRunToAgentSession(session.id, presetRunId);

  // Subscribe BEFORE running the loop. The emitter is shared across the
  // module-level sessionEmitters map keyed by sessionId.
  const emitter = getAgentRunEmitter(session.id);
  /** @type {Array<{ type: string, payload: object }>} */
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  let round = 0;
  const backendFetch = async () => {
    round++;
    if (round === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "Done without tools.",
              },
            },
          ],
        }),
      };
    }
    // Fallback (should not be reached).
    return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
  };

  const req = {
    userId: null,
    body: {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      // Critically: NO agentOptions.sessionId here — only a preset runId via
      // streamOptions, forcing resolution via the reverse index.
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const res = { headersSent: false, setHeader() {} };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  const result = await runAgentLoop(
    req,
    res,
    config,
    "m",
    { presetRunId },
    backendFetch,
  );
  assert.equal(result.runId, presetRunId);
  assert.equal(result.stopReason, "model_finished");

  // We expect at least one status.change (iteration start) and a done event.
  const hasStatusChange = observed.some((e) => e.type === "status.change");
  const hasDone = observed.some((e) => e.type === "done");
  assert.ok(
    hasStatusChange,
    `expected status.change event, got: ${observed.map((e) => e.type).join(",")}`,
  );
  assert.ok(
    hasDone,
    `expected done event, got: ${observed.map((e) => e.type).join(",")}`,
  );
});

test("executeAgentToolBatch publishes tool.call/tool.result events when only runId is known", async () => {
  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "exec-from-runid",
  });
  const runId = "run-exec-tools-from-runid-" + Date.now();
  await linkRunToAgentSession(session.id, runId);

  const emitter = getAgentRunEmitter(session.id);
  /** @type {Array<{ type: string, payload: object }>} */
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const toolCalls = [
    {
      id: "tc1",
      type: "function",
      function: { name: "list_context", arguments: "{}" },
    },
  ];
  const trajCollector = {
    record() {},
    truncate(s, n) {
      return String(s).slice(0, n);
    },
  };
  const policyState = createPolicyState({});

  const out = await executeAgentToolBatch({
    toolCalls,
    iteration: 1,
    runId,
    // Deliberately omit sessionId so the function resolves it via the reverse
    // index from runId.
    toolCtx: { allowExecution: false, workspace: "default", workspaceUserId: "anonymous" },
    policyState,
    toolCallsLog: [],
    trajCollector,
    traceRequestId: undefined,
    setStopPolicy: () => {},
    agentOpts: {},
    hitlContext: {},
  });

  assert.ok(Array.isArray(out.results));
  // We should see tool.call and (best-effort) tool.result events.
  const hasToolCall = observed.some((e) => e.type === "tool.call");
  const hasToolResult = observed.some((e) => e.type === "tool.result");
  assert.ok(
    hasToolCall,
    `expected tool.call event, got: ${observed.map((e) => e.type).join(",")}`,
  );
  assert.ok(
    hasToolResult,
    `expected tool.result event, got: ${observed.map((e) => e.type).join(",")}`,
  );
});
