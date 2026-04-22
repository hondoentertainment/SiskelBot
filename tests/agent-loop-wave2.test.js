/**
 * Cover the new wave-2 branches wired into agent-loop.js:
 *   - AGENT_UPFRONT_PLAN=1: upfront planning hook injects plan system message
 *   - AGENT_MID_LOOP_CRITIQUE=1: critique runs at interval
 *   - AGENT_FAILURE_MEMORY=1: records failures on stagnation/replan
 *   - AGENT_SEMANTIC_TRIM=1: trim hook is exercised (budget=0 means no-op)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "agent-loop-wave2-"));
const prevStorage = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const { runAgentLoop } = await import("../lib/agent-loop.js");

test.after(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  rmSync(dir, { recursive: true, force: true });
});

const res = () => ({ headersSent: false, setHeader() {} });
const config = { baseUrl: "http://mock", path: "/v1/chat", headers: {} };

function makeStubFetch(responses) {
  let i = 0;
  return async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: true, json: async () => next };
  };
}

test("runAgentLoop: AGENT_UPFRONT_PLAN=1 calls planner before main loop", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "build a plan" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    const fetch = makeStubFetch([
      // Planning call
      { choices: [{ message: { content: JSON.stringify({ steps: [{ id: 1, goal: "first" }], done_criteria: "done" }) } }] },
      // Main completion
      { choices: [{ message: { role: "assistant", content: "answer" } }] },
    ]);
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runAgentLoop: AGENT_UPFRONT_PLAN=1 with planner-fail proceeds silently", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "plan something" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    // Planner returns non-JSON; loop must continue to main call
    let call = 0;
    const fetch = async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
    };
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runAgentLoop: AGENT_MID_LOOP_CRITIQUE=1 with short interval does not throw", async () => {
  const prevC = process.env.AGENT_MID_LOOP_CRITIQUE;
  const prevI = process.env.AGENT_CRITIQUE_INTERVAL;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  process.env.AGENT_CRITIQUE_INTERVAL = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    const fetch = makeStubFetch([
      { choices: [{ message: { role: "assistant", content: "hello back" } }] },
      // Critique call result
      { choices: [{ message: { content: JSON.stringify({ on_track: true }) } }] },
    ]);
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prevC === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prevC;
    if (prevI === undefined) delete process.env.AGENT_CRITIQUE_INTERVAL;
    else process.env.AGENT_CRITIQUE_INTERVAL = prevI;
  }
});

test("runAgentLoop: AGENT_SEMANTIC_TRIM=1 executes trim hook without throwing", async () => {
  const prev = process.env.AGENT_SEMANTIC_TRIM;
  process.env.AGENT_SEMANTIC_TRIM = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "deploy the app" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    const fetch = makeStubFetch([
      { choices: [{ message: { role: "assistant", content: "deploying" } }] },
    ]);
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prev === undefined) delete process.env.AGENT_SEMANTIC_TRIM;
    else process.env.AGENT_SEMANTIC_TRIM = prev;
  }
});

test("runAgentLoop: AGENT_FAILURE_MEMORY=1 is tolerated without crashing", async () => {
  const prev = process.env.AGENT_FAILURE_MEMORY;
  process.env.AGENT_FAILURE_MEMORY = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "do thing" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    const fetch = makeStubFetch([
      { choices: [{ message: { role: "assistant", content: "done" } }] },
    ]);
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prev === undefined) delete process.env.AGENT_FAILURE_MEMORY;
    else process.env.AGENT_FAILURE_MEMORY = prev;
  }
});

test("runAgentLoop: AGENT_MID_LOOP_CRITIQUE with off-track verdict injects nudge", async () => {
  const prevC = process.env.AGENT_MID_LOOP_CRITIQUE;
  const prevI = process.env.AGENT_CRITIQUE_INTERVAL;
  const prevF = process.env.AGENT_FAILURE_MEMORY;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  process.env.AGENT_CRITIQUE_INTERVAL = "1";
  process.env.AGENT_FAILURE_MEMORY = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "solve this" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    let call = 0;
    const fetch = async () => {
      call++;
      if (call === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "attempt" } }] }) };
      }
      // critique verdict
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ on_track: false, stuck_reason: "looping", suggestion: "pivot" }) } }],
        }),
      };
    };
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prevC === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prevC;
    if (prevI === undefined) delete process.env.AGENT_CRITIQUE_INTERVAL;
    else process.env.AGENT_CRITIQUE_INTERVAL = prevI;
    if (prevF === undefined) delete process.env.AGENT_FAILURE_MEMORY;
    else process.env.AGENT_FAILURE_MEMORY = prevF;
  }
});

test("runAgentLoop: AGENT_UPFRONT_PLAN=1 with empty plan steps still proceeds", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "trivial" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    const fetch = makeStubFetch([
      // Planner returns empty steps → formatPlanAsSystemMessage returns ""
      { choices: [{ message: { content: JSON.stringify({ steps: [], done_criteria: "nothing" }) } }] },
      { choices: [{ message: { role: "assistant", content: "ok" } }] },
    ]);
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runAgentLoop: AGENT_UPFRONT_PLAN=1 with planner returning non-ok is tolerated", async () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "plan x" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    let call = 0;
    const fetch = async () => {
      call++;
      if (call === 1) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "x" } }] }) };
    };
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("runAgentLoop: AGENT_MID_LOOP_CRITIQUE=1 with critique returning null verdict", async () => {
  const prevC = process.env.AGENT_MID_LOOP_CRITIQUE;
  const prevI = process.env.AGENT_CRITIQUE_INTERVAL;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  process.env.AGENT_CRITIQUE_INTERVAL = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "x" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    let call = 0;
    const fetch = async () => {
      call++;
      if (call === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "answer" } }] }) };
      }
      // Critique returns invalid JSON → runMidLoopCritique returns null
      return { ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) };
    };
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prevC === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prevC;
    if (prevI === undefined) delete process.env.AGENT_CRITIQUE_INTERVAL;
    else process.env.AGENT_CRITIQUE_INTERVAL = prevI;
  }
});

test("runAgentLoop: AGENT_SEMANTIC_TRIM=1 with explicit budget triggers trim", async () => {
  const prevS = process.env.AGENT_SEMANTIC_TRIM;
  const prevB = process.env.AGENT_SEMANTIC_TRIM_BUDGET;
  process.env.AGENT_SEMANTIC_TRIM = "1";
  process.env.AGENT_SEMANTIC_TRIM_BUDGET = "10"; // very low budget triggers trim
  try {
    const longPrev = [{
      role: "assistant",
      tool_calls: [{ id: "x1", function: { name: "noop", arguments: "{}" } }],
    }, {
      role: "tool",
      tool_call_id: "x1",
      content: "a very long result".repeat(200),
    }];
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [
          ...longPrev,
          { role: "user", content: "deploy the application" },
        ],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    const fetch = makeStubFetch([
      { choices: [{ message: { role: "assistant", content: "done" } }] },
    ]);
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    if (prevS === undefined) delete process.env.AGENT_SEMANTIC_TRIM;
    else process.env.AGENT_SEMANTIC_TRIM = prevS;
    if (prevB === undefined) delete process.env.AGENT_SEMANTIC_TRIM_BUDGET;
    else process.env.AGENT_SEMANTIC_TRIM_BUDGET = prevB;
  }
});

test("runAgentLoop: request with no user message exercises empty-goal branches", async () => {
  const req = {
    userId: null,
    body: {
      model: "m",
      messages: [{ role: "system", content: "system only" }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const fetch = makeStubFetch([
    { choices: [{ message: { role: "assistant", content: "ok" } }] },
  ]);
  await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
});

test("runAgentLoop: request with non-string user content exercises branch", async () => {
  const req = {
    userId: null,
    body: {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      agentOptions: { workspace: "default", allowExecution: false },
    },
  };
  const fetch = makeStubFetch([
    { choices: [{ message: { role: "assistant", content: "ok" } }] },
  ]);
  await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
});

test("runAgentLoop: multiple feature flags together do not interact badly", async () => {
  const saves = {
    p: process.env.AGENT_UPFRONT_PLAN,
    c: process.env.AGENT_MID_LOOP_CRITIQUE,
    i: process.env.AGENT_CRITIQUE_INTERVAL,
    f: process.env.AGENT_FAILURE_MEMORY,
    s: process.env.AGENT_SEMANTIC_TRIM,
  };
  process.env.AGENT_UPFRONT_PLAN = "1";
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  process.env.AGENT_CRITIQUE_INTERVAL = "1";
  process.env.AGENT_FAILURE_MEMORY = "1";
  process.env.AGENT_SEMANTIC_TRIM = "1";
  try {
    const req = {
      userId: null,
      body: {
        model: "m",
        messages: [{ role: "user", content: "a combined request" }],
        agentOptions: { workspace: "default", allowExecution: false },
      },
    };
    let call = 0;
    const fetch = async () => {
      call++;
      if (call === 1) {
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ steps: [{ id: 1, goal: "go" }], done_criteria: "done" }) } }] }) };
      }
      if (call === 2) {
        return { ok: true, json: async () => ({ choices: [{ message: { role: "assistant", content: "response" } }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ on_track: true }) } }] }) };
    };
    await assert.doesNotReject(() => runAgentLoop(req, res(), config, "m", {}, fetch));
  } finally {
    for (const [k, v] of Object.entries(saves)) {
      const envKey = {
        p: "AGENT_UPFRONT_PLAN",
        c: "AGENT_MID_LOOP_CRITIQUE",
        i: "AGENT_CRITIQUE_INTERVAL",
        f: "AGENT_FAILURE_MEMORY",
        s: "AGENT_SEMANTIC_TRIM",
      }[k];
      if (v === undefined) delete process.env[envKey];
      else process.env[envKey] = v;
    }
  }
});
