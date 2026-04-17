/**
 * Integration-ish test: synthesize a swarm run with two specialists each
 * producing usage and assert at least one cost.update per specialist fires
 * on the parent swarm run's Agent Run emitter.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "swarm-cost-update-"));
const prevStoragePath = process.env.STORAGE_PATH;
const prevParallel = process.env.SWARM_PARALLEL_AGENTS;
const prevStreamSynth = process.env.STREAM_SWARM_SYNTH;
process.env.STORAGE_PATH = dir;
// Force two specialists (researcher + executor) to run so we can assert 2 emits.
process.env.SWARM_PARALLEL_AGENTS = "1";
// Keep the synth synchronous (no streaming) so its cost.update also fires.
delete process.env.STREAM_SWARM_SYNTH;

const { createAgentSession, linkRunToAgentSession } = await import(
  "../lib/agent-session.js"
);
const {
  getAgentRunEmitter,
  __resetAgentRunStreamForTests,
} = await import("../lib/agent-run-stream.js");
const { __resetAccumulatorsForTests } = await import(
  "../lib/agent-cost-emitter.js"
);
const { parseCostConfig } = await import("../lib/smart-router.js");
const { runSwarm } = await import("../lib/swarm.js");

test.after(() => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("");
  if (prevStoragePath === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStoragePath;
  if (prevParallel === undefined) delete process.env.SWARM_PARALLEL_AGENTS;
  else process.env.SWARM_PARALLEL_AGENTS = prevParallel;
  if (prevStreamSynth !== undefined) process.env.STREAM_SWARM_SYNTH = prevStreamSynth;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a stub fetch: every call returns a canned chat-completion with usage.
 * Each specialist loop exits after one iteration (no tool calls), the
 * synthesizer also returns in one call. With two specialists + synth that's
 * three calls; the first two should each trigger a cost.update on the swarm
 * run's emitter.
 */
function makeStubFetch() {
  let callCount = 0;
  return async () => {
    callCount += 1;
    return {
      ok: true,
      async json() {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: `response-${callCount}`,
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        };
      },
      async text() { return ""; },
    };
  };
}

test("swarm emits cost.update per specialist completion", async () => {
  __resetAgentRunStreamForTests();
  __resetAccumulatorsForTests();
  parseCostConfig("swarm-model:0.002,researcher:0.002,executor:0.002,synthesizer:0.002");

  const session = await createAgentSession({
    workspace: "default",
    ownerStorageUserId: "anonymous",
    title: "swarm-cost-update",
  });

  // We need the swarm's generated runId linked so liveSessionId resolves.
  // runSwarm internally generates a new runId via randomUUID(). Since the
  // caller can't know it up-front, we pass sessionId via agentOptions so
  // liveSessionId is resolved from that directly (no reverse-index lookup).
  const emitter = getAgentRunEmitter(session.id);
  /** @type {Array<{type:string,payload:any}>} */
  const observed = [];
  emitter.on("event", (ev) => observed.push(ev));

  const req = {
    userId: null,
    body: {
      model: "swarm-model",
      messages: [
        // "research and plan" should trigger researcher + executor intent
        { role: "user", content: "research and plan this task" },
      ],
      agentOptions: {
        workspace: "default",
        allowExecution: false,
        sessionId: session.id,
      },
    },
  };
  const res = {
    headersSent: false,
    setHeader() {},
  };
  const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

  // We don't need to link — runSwarm resolves liveSessionId from agentOpts.sessionId.
  void linkRunToAgentSession; // suppress unused warning

  await runSwarm(req, res, config, "swarm-model", {
    backendFetch: makeStubFetch(),
    maxIterations: 2,
  });

  const cost = observed.filter((e) => e.type === "cost.update");
  // Expect at least 2: one per specialist. Synth also emits → 3 total.
  assert.ok(
    cost.length >= 2,
    `expected >= 2 cost.update events, got ${cost.length}`,
  );
  // All events carry a numeric totalUsd and tokens.total.
  for (const c of cost) {
    assert.equal(typeof c.payload.totalUsd, "number");
    assert.equal(typeof c.payload.tokens.total, "number");
    assert.ok(c.payload.runId, "runId should be present");
  }
  // Cumulative monotonicity across the swarm run.
  for (let i = 1; i < cost.length; i++) {
    assert.ok(
      cost[i].payload.totalUsd >= cost[i - 1].payload.totalUsd,
      `totalUsd should be monotonic; got ${cost[i - 1].payload.totalUsd} -> ${cost[i].payload.totalUsd}`,
    );
  }
});
