import test from "node:test";
import assert from "node:assert/strict";
import { debateEnabled, runDebateRound } from "../lib/swarm-debate.js";

test("debateEnabled: false by default", () => {
  const prev = process.env.SWARM_DEBATE;
  delete process.env.SWARM_DEBATE;
  try {
    assert.equal(debateEnabled(), false);
  } finally {
    if (prev !== undefined) process.env.SWARM_DEBATE = prev;
  }
});

test("runDebateRound: returns empty when fewer than 2 specialists", async () => {
  const r = await runDebateRound({
    results: [{ specialist: "a", content: "x" }],
    userMessage: "goal",
    backendFetch: async () => ({ ok: true, json: async () => ({}) }),
    url: "u",
    model: "m",
  });
  assert.deepEqual(r, []);
});

test("runDebateRound: preserves originals when fetch fails", async () => {
  const r = await runDebateRound({
    results: [
      { specialist: "a", content: "draft A" },
      { specialist: "b", content: "draft B" },
    ],
    userMessage: "goal",
    backendFetch: async () => ({ ok: false }),
    url: "u",
    model: "m",
  });
  assert.equal(r.length, 2);
  for (const rev of r) {
    assert.equal(rev.changed, false);
    assert.equal(rev.original, rev.revised);
  }
});

test("runDebateRound: applies revisions from backend", async () => {
  let calls = 0;
  const stub = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: `revised ${calls}` } }],
      }),
    };
  };
  const r = await runDebateRound({
    results: [
      { specialist: "a", content: "draft A" },
      { specialist: "b", content: "draft B" },
    ],
    userMessage: "goal",
    backendFetch: stub,
    url: "u",
    model: "m",
  });
  assert.equal(r.length, 2);
  // Each specialist got a backend call
  assert.ok(calls >= 2);
  // All were changed since revised text differs from original
  assert.ok(r.every((x) => x.changed));
});

test("runDebateRound: treats empty revisions as unchanged", async () => {
  const stub = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "" } }] }),
  });
  const r = await runDebateRound({
    results: [
      { specialist: "a", content: "draft A" },
      { specialist: "b", content: "draft B" },
    ],
    userMessage: "goal",
    backendFetch: stub,
    url: "u",
    model: "m",
  });
  for (const rev of r) {
    assert.equal(rev.changed, false);
  }
});
