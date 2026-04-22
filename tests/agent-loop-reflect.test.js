/**
 * Exercise the AGENT_PLAN_REFLECT=1 reflection path and the ENABLE_METRICS=1
 * metrics recording block in runAgentLoop — both previously had zero hits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-reflect-"));
const prevStorage = process.env.STORAGE_PATH;
const prevReflect = process.env.AGENT_PLAN_REFLECT;
const prevMetrics = process.env.ENABLE_METRICS;
process.env.STORAGE_PATH = dir;
process.env.AGENT_PLAN_REFLECT = "1";
process.env.ENABLE_METRICS = "1";

const { runAgentLoop } = await import("../lib/agent-loop.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  if (prevReflect === undefined) delete process.env.AGENT_PLAN_REFLECT;
  else process.env.AGENT_PLAN_REFLECT = prevReflect;
  if (prevMetrics === undefined) delete process.env.ENABLE_METRICS;
  else process.env.ENABLE_METRICS = prevMetrics;
  rmSync(dir, { recursive: true, force: true });
});

function makeStubFetch(responses) {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, json: async () => next };
  };
}

const baseRes = () => ({ headersSent: false, setHeader() {} });
const baseConfig = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

test("runAgentLoop with AGENT_PLAN_REFLECT=1 executes reflection call without throwing", async () => {
  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "What is 2+2?" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };

  // First call: main completion; Second call: reflection summary
  const fetch = makeStubFetch([
    {
      choices: [{ message: { role: "assistant", content: "The answer is 4." } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    {
      choices: [{ message: { role: "assistant", content: "Computed 2+2=4. No follow-ups needed." } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    },
  ]);

  await assert.doesNotReject(() =>
    runAgentLoop(req, baseRes(), baseConfig, "test-model", {}, fetch),
  );
});

test("runAgentLoop with ENABLE_METRICS=1 records phase timings without throwing", async () => {
  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };

  const fetch = makeStubFetch([
    {
      choices: [{ message: { role: "assistant", content: "Hello!" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
    // reflection call
    {
      choices: [{ message: { role: "assistant", content: "Responded to greeting." } }],
    },
  ]);

  await assert.doesNotReject(() =>
    runAgentLoop(req, baseRes(), baseConfig, "test-model", {}, fetch),
  );
});

test("runAgentLoop reflection with non-ok reflection response still completes", async () => {
  const req = {
    userId: null,
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "summarise" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };

  let callCount = 0;
  const fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "Summary here." } }] }) };
    }
    // Reflection call returns non-ok response
    return { ok: false, status: 503, json: async () => ({}) };
  };

  await assert.doesNotReject(() =>
    runAgentLoop(req, baseRes(), baseConfig, "test-model", {}, fetch),
  );
});
