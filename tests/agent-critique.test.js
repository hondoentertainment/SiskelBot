import test from "node:test";
import assert from "node:assert/strict";
import {
  critiqueEnabled,
  getCritiqueInterval,
  shouldCritique,
  runMidLoopCritique,
  formatCritiqueNudge,
} from "../lib/agent-critique.js";

test("critiqueEnabled: false by default", () => {
  const prev = process.env.AGENT_MID_LOOP_CRITIQUE;
  delete process.env.AGENT_MID_LOOP_CRITIQUE;
  try {
    assert.equal(critiqueEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_MID_LOOP_CRITIQUE = prev;
  }
});

test("getCritiqueInterval: default 3", () => {
  const prev = process.env.AGENT_CRITIQUE_INTERVAL;
  delete process.env.AGENT_CRITIQUE_INTERVAL;
  try {
    assert.equal(getCritiqueInterval(), 3);
  } finally {
    if (prev !== undefined) process.env.AGENT_CRITIQUE_INTERVAL = prev;
  }
});

test("shouldCritique: false when flag off", () => {
  const prev = process.env.AGENT_MID_LOOP_CRITIQUE;
  delete process.env.AGENT_MID_LOOP_CRITIQUE;
  try {
    assert.equal(shouldCritique(3), false);
  } finally {
    if (prev !== undefined) process.env.AGENT_MID_LOOP_CRITIQUE = prev;
  }
});

test("shouldCritique: true at interval when flag on", () => {
  const prev = process.env.AGENT_MID_LOOP_CRITIQUE;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  try {
    assert.equal(shouldCritique(3), true);
    assert.equal(shouldCritique(6), true);
    assert.equal(shouldCritique(4), false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prev;
  }
});

test("shouldCritique: true on stagnation regardless of interval", () => {
  const prev = process.env.AGENT_MID_LOOP_CRITIQUE;
  process.env.AGENT_MID_LOOP_CRITIQUE = "1";
  try {
    assert.equal(shouldCritique(1, { stagnant: true }), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MID_LOOP_CRITIQUE;
    else process.env.AGENT_MID_LOOP_CRITIQUE = prev;
  }
});

test("runMidLoopCritique: returns null on fetch failure", async () => {
  const r = await runMidLoopCritique({
    messages: [],
    userGoal: "x",
    backendFetch: async () => ({ ok: false }),
    url: "u",
    model: "m",
  });
  assert.equal(r, null);
});

test("runMidLoopCritique: parses on_track=true verdict", async () => {
  const stub = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ on_track: true }) } }] }),
  });
  const r = await runMidLoopCritique({ messages: [], userGoal: "x", backendFetch: stub, url: "u", model: "m" });
  assert.ok(r);
  assert.equal(r.on_track, true);
});

test("runMidLoopCritique: parses off-track verdict with suggestion", async () => {
  const stub = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ on_track: false, stuck_reason: "loop", suggestion: "try X" }) } }],
    }),
  });
  const r = await runMidLoopCritique({ messages: [], userGoal: "x", backendFetch: stub, url: "u", model: "m" });
  assert.equal(r.on_track, false);
  assert.equal(r.stuck_reason, "loop");
  assert.equal(r.suggestion, "try X");
});

test("formatCritiqueNudge: empty when on_track", () => {
  assert.equal(formatCritiqueNudge({ on_track: true }), "");
});

test("formatCritiqueNudge: formats stuck verdict", () => {
  const nudge = formatCritiqueNudge({ on_track: false, stuck_reason: "looped", suggestion: "try new tool" });
  assert.match(nudge, /Self-critique/);
  assert.match(nudge, /looped/);
  assert.match(nudge, /try new tool/);
});
