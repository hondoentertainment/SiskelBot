/**
 * Unit tests for lib/tool-cooldown-store.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate persistent failure stats to a temp dir.
const TMP = mkdtempSync(join(tmpdir(), "cooldown-store-"));
process.env.STORAGE_PATH = TMP;

// Import AFTER STORAGE_PATH is set.
const cooldownMod = await import("../lib/tool-cooldown-store.js");
const failureStore = await import("../lib/agent-failure-store.js");

const {
  startCooldown,
  isToolInCooldown,
  listActiveCooldowns,
  clearCooldown,
  clearAllCooldowns,
  maybeStartCooldownFromFailures,
  cooldownEnabled,
  __resetAllCooldownsForTests,
} = cooldownMod;

test.beforeEach(() => {
  __resetAllCooldownsForTests();
});

test("startCooldown + isToolInCooldown + clearCooldown lifecycle", () => {
  const ws = "ws-life";
  assert.equal(isToolInCooldown(ws, "tool_a"), false);
  startCooldown(ws, "tool_a", "manual", 60_000);
  assert.equal(isToolInCooldown(ws, "tool_a"), true);

  const active = listActiveCooldowns(ws);
  assert.equal(active.length, 1);
  assert.equal(active[0].tool, "tool_a");
  assert.equal(active[0].reason, "manual");
  assert.ok(active[0].expiresAt > Date.now());

  clearCooldown(ws, "tool_a");
  assert.equal(isToolInCooldown(ws, "tool_a"), false);
  assert.deepEqual(listActiveCooldowns(ws), []);
});

test("startCooldown with tiny durationMs expires (lazy cleanup on read)", async () => {
  const ws = "ws-expiry";
  startCooldown(ws, "tool_b", "brief", 15);
  assert.equal(isToolInCooldown(ws, "tool_b"), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(isToolInCooldown(ws, "tool_b"), false);
  assert.deepEqual(listActiveCooldowns(ws), []);
});

test("clearAllCooldowns drops every entry for a workspace", () => {
  const ws = "ws-clear-all";
  startCooldown(ws, "t1", "r", 60_000);
  startCooldown(ws, "t2", "r", 60_000);
  assert.equal(listActiveCooldowns(ws).length, 2);
  clearAllCooldowns(ws);
  assert.equal(listActiveCooldowns(ws).length, 0);
  assert.equal(isToolInCooldown(ws, "t1"), false);
  assert.equal(isToolInCooldown(ws, "t2"), false);
});

test("maybeStartCooldownFromFailures triggers when terminal failures >= threshold", async () => {
  const ws = "ws-terminal-5";
  await failureStore.resetFailureStats(ws);
  for (let i = 0; i < 5; i++) {
    await failureStore.recordFailure(ws, "tool_x", "permission");
  }
  const result = await maybeStartCooldownFromFailures(ws, "tool_x");
  assert.equal(result.started, true);
  assert.equal(result.terminalCount, 5);
  assert.ok(result.threshold >= 1);
  assert.match(result.reason, /permission/);
  assert.equal(isToolInCooldown(ws, "tool_x"), true);
});

test("maybeStartCooldownFromFailures does NOT trigger below threshold (2 failures)", async () => {
  const ws = "ws-below-thresh";
  await failureStore.resetFailureStats(ws);
  await failureStore.recordFailure(ws, "tool_y", "permission");
  await failureStore.recordFailure(ws, "tool_y", "not_allowed");
  const result = await maybeStartCooldownFromFailures(ws, "tool_y");
  assert.equal(result.started, false);
  assert.equal(result.terminalCount, 2);
  assert.equal(isToolInCooldown(ws, "tool_y"), false);
});

test("maybeStartCooldownFromFailures ignores transient categories (10 rate_limit)", async () => {
  const ws = "ws-transient";
  await failureStore.resetFailureStats(ws);
  for (let i = 0; i < 10; i++) {
    await failureStore.recordFailure(ws, "tool_rl", "rate_limit");
  }
  const result = await maybeStartCooldownFromFailures(ws, "tool_rl");
  assert.equal(result.started, false);
  assert.equal(result.terminalCount, 0);
  assert.equal(isToolInCooldown(ws, "tool_rl"), false);
});

test("maybeStartCooldownFromFailures is idempotent (already cooling down)", async () => {
  const ws = "ws-idempotent";
  await failureStore.resetFailureStats(ws);
  for (let i = 0; i < 5; i++) {
    await failureStore.recordFailure(ws, "tool_z", "validation");
  }
  const first = await maybeStartCooldownFromFailures(ws, "tool_z");
  assert.equal(first.started, true);
  const second = await maybeStartCooldownFromFailures(ws, "tool_z");
  assert.equal(second.started, false);
  assert.equal(second.alreadyActive, true);
});

test("maybeStartCooldownFromFailures counts across multiple terminal categories", async () => {
  const ws = "ws-mixed-terminal";
  await failureStore.resetFailureStats(ws);
  await failureStore.recordFailure(ws, "tool_m", "permission");
  await failureStore.recordFailure(ws, "tool_m", "permission");
  await failureStore.recordFailure(ws, "tool_m", "not_allowed");
  await failureStore.recordFailure(ws, "tool_m", "unknown_tool");
  await failureStore.recordFailure(ws, "tool_m", "validation");
  const result = await maybeStartCooldownFromFailures(ws, "tool_m");
  assert.equal(result.started, true);
  assert.equal(result.terminalCount, 5);
});

test("cooldowns are isolated per workspace", () => {
  startCooldown("ws-A", "shared_tool", "r", 60_000);
  assert.equal(isToolInCooldown("ws-A", "shared_tool"), true);
  assert.equal(isToolInCooldown("ws-B", "shared_tool"), false);
  assert.equal(listActiveCooldowns("ws-B").length, 0);
});

test("cooldownEnabled respects TOOL_COOLDOWN_ENABLED=0", () => {
  const prev = process.env.TOOL_COOLDOWN_ENABLED;
  try {
    delete process.env.TOOL_COOLDOWN_ENABLED;
    assert.equal(cooldownEnabled(), true);
    process.env.TOOL_COOLDOWN_ENABLED = "1";
    assert.equal(cooldownEnabled(), true);
    process.env.TOOL_COOLDOWN_ENABLED = "0";
    assert.equal(cooldownEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.TOOL_COOLDOWN_ENABLED;
    else process.env.TOOL_COOLDOWN_ENABLED = prev;
  }
});

test("COOLDOWN_TERMINAL_THRESHOLD env overrides the default threshold", async () => {
  const prevThresh = process.env.COOLDOWN_TERMINAL_THRESHOLD;
  const ws = "ws-env-thresh";
  try {
    process.env.COOLDOWN_TERMINAL_THRESHOLD = "2";
    await failureStore.resetFailureStats(ws);
    await failureStore.recordFailure(ws, "tool_env", "permission");
    await failureStore.recordFailure(ws, "tool_env", "permission");
    const r = await maybeStartCooldownFromFailures(ws, "tool_env");
    assert.equal(r.started, true);
    assert.equal(r.threshold, 2);
  } finally {
    if (prevThresh === undefined) delete process.env.COOLDOWN_TERMINAL_THRESHOLD;
    else process.env.COOLDOWN_TERMINAL_THRESHOLD = prevThresh;
  }
});

test("listActiveCooldowns prunes expired entries before returning", async () => {
  const ws = "ws-list-prune";
  startCooldown(ws, "still_valid", "r", 60_000);
  startCooldown(ws, "gone_soon", "r", 15);
  await new Promise((r) => setTimeout(r, 40));
  const active = listActiveCooldowns(ws);
  assert.equal(active.length, 1);
  assert.equal(active[0].tool, "still_valid");
});
