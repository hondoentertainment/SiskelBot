import test from "node:test";
import assert from "node:assert/strict";
import { planningEnabled, buildUpfrontPlan, formatPlanAsSystemMessage } from "../lib/agent-plan.js";

test("planningEnabled: false by default", () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  delete process.env.AGENT_UPFRONT_PLAN;
  try {
    assert.equal(planningEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("planningEnabled: true when AGENT_UPFRONT_PLAN=1", () => {
  const prev = process.env.AGENT_UPFRONT_PLAN;
  process.env.AGENT_UPFRONT_PLAN = "1";
  try {
    assert.equal(planningEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_UPFRONT_PLAN;
    else process.env.AGENT_UPFRONT_PLAN = prev;
  }
});

test("buildUpfrontPlan: returns null when userMessage missing", async () => {
  const r = await buildUpfrontPlan({ userMessage: "", backendFetch: async () => ({}), url: "u", model: "m" });
  assert.equal(r, null);
});

test("buildUpfrontPlan: returns null when backendFetch fails", async () => {
  const r = await buildUpfrontPlan({
    userMessage: "hi",
    backendFetch: async () => ({ ok: false }),
    url: "u",
    model: "m",
  });
  assert.equal(r, null);
});

test("buildUpfrontPlan: parses valid JSON plan", async () => {
  const stub = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ steps: [{ id: 1, goal: "find files" }], done_criteria: "files found" }) } }],
    }),
  });
  const r = await buildUpfrontPlan({ userMessage: "find all files", backendFetch: stub, url: "u", model: "m" });
  assert.ok(r);
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].goal, "find files");
  assert.equal(r.done_criteria, "files found");
});

test("buildUpfrontPlan: returns null on invalid JSON", async () => {
  const stub = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "not json" } }] }),
  });
  const r = await buildUpfrontPlan({ userMessage: "hi", backendFetch: stub, url: "u", model: "m" });
  assert.equal(r, null);
});

test("formatPlanAsSystemMessage: returns empty for empty plan", () => {
  assert.equal(formatPlanAsSystemMessage(null), "");
  assert.equal(formatPlanAsSystemMessage({ steps: [], done_criteria: "x" }), "");
});

test("formatPlanAsSystemMessage: formats plan with steps and done criteria", () => {
  const msg = formatPlanAsSystemMessage({
    steps: [
      { id: 1, goal: "first", tool_hint: "search" },
      { id: 2, goal: "second", depends_on: [1] },
    ],
    done_criteria: "all done",
  });
  assert.match(msg, /Task Plan/);
  assert.match(msg, /first/);
  assert.match(msg, /second/);
  assert.match(msg, /search/);
  assert.match(msg, /all done/);
});
