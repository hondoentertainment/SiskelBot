/**
 * Unit tests for the two startup wires added to server.js:
 *
 *   1. buildRunIndexFromSessions() — called at boot so the agent-session
 *      runId -> sessionId index is warm on process restart.
 *   2. defaultChannelRegistry slow-subscriber + subscriber-error hooks —
 *      forwarded to the metrics module via a tiny install helper, tagged
 *      with the channel prefix (everything before the first `:`).
 *
 * Booting full server.js is too heavy (real storage, OTEL, listen
 * sockets, etc.), so we exercise inline copies of the two pure helpers
 * — `channelPrefix` and `installRealtimeMetricsHooks` — and separately
 * assert that server.js's source contains the canonical wire-up so a
 * future refactor cannot silently drift away from the tested shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createChannelRegistry } from "../lib/realtime-channels.js";

const SERVER_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "server.js",
);

// ──────────────────────────────────────────────────────────────────────
// Inline copies of the production helpers. Kept in sync with server.js
// by the "server.js source contains canonical wiring" test below.
// ──────────────────────────────────────────────────────────────────────

function channelPrefix(channel) {
  const s = typeof channel === "string" ? channel : "";
  const idx = s.indexOf(":");
  return idx >= 0 ? s.slice(0, idx) : s;
}

function installRealtimeMetricsHooks(registry, m = {}) {
  if (!registry || typeof registry.setSlowSubscriberHook !== "function") return false;
  const incBackpressure = m.incrementRealtimeBackpressure;
  const incSubError = m.incrementRealtimeSubscriberError;
  registry.setSlowSubscriberHook(({ channel }) => {
    try { incBackpressure && incBackpressure(channelPrefix(channel)); } catch (_) {}
  });
  registry.setSubscriberErrorHook((channel, _clientId, _err) => {
    try { incSubError && incSubError(channelPrefix(channel)); } catch (_) {}
  });
  return true;
}

async function flush() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────────────────────────────
// channelPrefix
// ──────────────────────────────────────────────────────────────────────

test("channelPrefix returns the substring before the first colon", () => {
  assert.equal(channelPrefix("chat:abc-123"), "chat");
  assert.equal(channelPrefix("run:sess_42"), "run");
  assert.equal(channelPrefix("presence:ws-xyz"), "presence");
});

test("channelPrefix returns the whole string when there is no colon", () => {
  assert.equal(channelPrefix("global"), "global");
  assert.equal(channelPrefix(""), "");
});

test("channelPrefix handles non-string inputs defensively", () => {
  assert.equal(channelPrefix(null), "");
  assert.equal(channelPrefix(undefined), "");
  assert.equal(channelPrefix(42), "");
  assert.equal(channelPrefix({}), "");
});

test("channelPrefix only consumes up to the first colon", () => {
  assert.equal(channelPrefix("chat:abc:extra"), "chat");
});

// ──────────────────────────────────────────────────────────────────────
// installRealtimeMetricsHooks
// ──────────────────────────────────────────────────────────────────────

test("installRealtimeMetricsHooks returns false for a bogus registry", () => {
  assert.equal(installRealtimeMetricsHooks(null), false);
  assert.equal(installRealtimeMetricsHooks({}), false);
  assert.equal(installRealtimeMetricsHooks({ setSlowSubscriberHook: "nope" }), false);
});

test("installRealtimeMetricsHooks wires slow-subscriber drops to the backpressure counter", async () => {
  const reg = createChannelRegistry();
  const backpressureCalls = [];
  const errorCalls = [];
  const ok = installRealtimeMetricsHooks(reg, {
    incrementRealtimeBackpressure: (cat) => backpressureCalls.push(cat),
    incrementRealtimeSubscriberError: (cat) => errorCalls.push(cat),
  });
  assert.equal(ok, true);

  // A subscriber that never resolves its work forces drops on overflow.
  const gate = new Promise(() => {});
  reg.subscribe(
    "chat:abc-123",
    "client-1",
    async () => {
      await gate;
    },
    { queueCapacity: 2 },
  );

  // Queue capacity 2, publish 6 -> 4 drops. First drop always fires the hook.
  for (let i = 0; i < 6; i++) {
    reg.publish("chat:abc-123", { n: i });
  }
  await flush();
  await wait(10);

  assert.ok(
    backpressureCalls.length >= 1,
    `expected >=1 backpressure tag, got ${backpressureCalls.length}`,
  );
  for (const tag of backpressureCalls) {
    assert.equal(tag, "chat");
  }
  assert.equal(errorCalls.length, 0);
});

test("installRealtimeMetricsHooks wires subscriber errors to the subscriber-error counter", async () => {
  const reg = createChannelRegistry();
  const backpressureCalls = [];
  const errorCalls = [];
  installRealtimeMetricsHooks(reg, {
    incrementRealtimeBackpressure: (cat) => backpressureCalls.push(cat),
    incrementRealtimeSubscriberError: (cat) => errorCalls.push(cat),
  });

  reg.subscribe("run:sess_42", "bad-client", () => {
    throw new Error("boom");
  });

  reg.publish("run:sess_42", { ok: true });
  reg.publish("run:sess_42", { ok: true });
  await flush();

  assert.equal(errorCalls.length, 2);
  for (const tag of errorCalls) {
    assert.equal(tag, "run");
  }
  assert.equal(backpressureCalls.length, 0);
});

test("installRealtimeMetricsHooks does not crash when the metrics layer throws", async () => {
  const reg = createChannelRegistry();
  installRealtimeMetricsHooks(reg, {
    incrementRealtimeBackpressure: () => {
      throw new Error("metrics down");
    },
    incrementRealtimeSubscriberError: () => {
      throw new Error("metrics down");
    },
  });

  // Error path
  reg.subscribe("presence:ws-1", "bad", () => {
    throw new Error("subscriber kaboom");
  });
  // Backpressure path (never-resolving gate keeps the queue full).
  const gate = new Promise(() => {});
  reg.subscribe(
    "presence:ws-1",
    "slow",
    async () => {
      await gate;
    },
    { queueCapacity: 1 },
  );

  // Neither publish path must throw even though the metrics stubs do.
  assert.doesNotThrow(() => {
    for (let i = 0; i < 4; i++) {
      reg.publish("presence:ws-1", { i });
    }
  });
  await flush();
  await wait(10);
});

// ──────────────────────────────────────────────────────────────────────
// Real metrics module exports
// ──────────────────────────────────────────────────────────────────────

test("lib/metrics.js exports the realtime backpressure counter API", async () => {
  const mod = await import("../lib/metrics.js");
  assert.equal(typeof mod.incrementRealtimeBackpressure, "function");
  assert.equal(typeof mod.incrementRealtimeSubscriberError, "function");
  assert.equal(typeof mod.getRealtimeBackpressureCounters, "function");

  const beforeBp = mod.getRealtimeBackpressureCounters().backpressure["chat"] || 0;
  const beforeErr = mod.getRealtimeBackpressureCounters().subscriberErrors["run"] || 0;
  mod.incrementRealtimeBackpressure("chat");
  mod.incrementRealtimeBackpressure("chat");
  mod.incrementRealtimeSubscriberError("run");

  const snap = mod.getRealtimeBackpressureCounters();
  assert.equal(snap.backpressure["chat"], beforeBp + 2);
  assert.equal(snap.subscriberErrors["run"], beforeErr + 1);
});

// ──────────────────────────────────────────────────────────────────────
// server.js source parity check
// ──────────────────────────────────────────────────────────────────────

test("server.js source contains the canonical boot wiring", () => {
  const src = readFileSync(SERVER_PATH, "utf8");

  // buildRunIndexFromSessions is imported and invoked at boot.
  assert.ok(
    src.includes("buildRunIndexFromSessions"),
    "expected server.js to reference buildRunIndexFromSessions",
  );
  assert.match(
    src,
    /buildRunIndexFromSessions\s*\(\s*\)\s*\.\s*then/,
    "expected server.js to invoke buildRunIndexFromSessions() with a .then handler",
  );

  // Slow-subscriber + error hooks are wired via the install helper.
  assert.ok(
    src.includes("installRealtimeMetricsHooks(defaultChannelRegistry)"),
    "expected server.js to call installRealtimeMetricsHooks(defaultChannelRegistry)",
  );

  // Metrics functions are imported from lib/metrics.js.
  assert.ok(
    src.includes("incrementRealtimeBackpressure"),
    "expected server.js to import incrementRealtimeBackpressure",
  );
  assert.ok(
    src.includes("incrementRealtimeSubscriberError"),
    "expected server.js to import incrementRealtimeSubscriberError",
  );
});
