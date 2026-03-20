/**
 * Phase 60: Default agent system instructions from env.
 */
import test from "node:test";
import assert from "node:assert/strict";

test("augmentMessagesWithDefaultSystem no-op when env unset", async () => {
  const prev = process.env.AGENT_DEFAULT_SYSTEM;
  delete process.env.AGENT_DEFAULT_SYSTEM;
  try {
    const mod = await import(`../lib/agent-defaults.js?t=${Date.now()}`);
    const out = mod.augmentMessagesWithDefaultSystem([{ role: "user", content: "hi" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].content, "hi");
  } finally {
    if (prev !== undefined) process.env.AGENT_DEFAULT_SYSTEM = prev;
  }
});

test("augmentMessagesWithDefaultSystem prepends system when no system message", async () => {
  const prev = process.env.AGENT_DEFAULT_SYSTEM;
  process.env.AGENT_DEFAULT_SYSTEM = "Always be concise.";
  try {
    const mod = await import(`../lib/agent-defaults.js?t=${Date.now() + 1}`);
    const out = mod.augmentMessagesWithDefaultSystem([{ role: "user", content: "hi" }]);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, "system");
    assert.match(out[0].content, /concise/);
    assert.equal(out[1].content, "hi");
  } finally {
    if (prev !== undefined) process.env.AGENT_DEFAULT_SYSTEM = prev;
    else delete process.env.AGENT_DEFAULT_SYSTEM;
  }
});

test("augmentMessagesWithDefaultSystem appends to existing system", async () => {
  const prev = process.env.AGENT_DEFAULT_SYSTEM;
  process.env.AGENT_DEFAULT_SYSTEM = "Use metric units.";
  try {
    const mod = await import(`../lib/agent-defaults.js?t=${Date.now() + 2}`);
    const out = mod.augmentMessagesWithDefaultSystem([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hi" },
    ]);
    assert.equal(out.length, 2);
    assert.match(out[0].content, /helpful/);
    assert.match(out[0].content, /metric/);
  } finally {
    if (prev !== undefined) process.env.AGENT_DEFAULT_SYSTEM = prev;
    else delete process.env.AGENT_DEFAULT_SYSTEM;
  }
});
