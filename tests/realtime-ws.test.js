/**
 * Integration tests for routes/realtime-ws.js.
 *
 * Spins up a real http.Server, mounts the unified realtime WS handler,
 * and uses the `ws` client package to exercise the protocol end-to-end.
 *
 * The `ws` package is listed in package.json dependencies, but in a
 * fresh checkout without `node_modules` the import will fail — in that
 * case we skip the suite cleanly so `npm test` still passes on a bare
 * worktree. A warning is logged so the skip is visible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

import { createChannelRegistry } from "../lib/realtime-channels.js";
import { mountRealtimeWs, REALTIME_WS_PATH } from "../routes/realtime-ws.js";

let WS;
try {
  ({ WebSocket: WS } = await import("ws"));
} catch {
  // eslint-disable-next-line no-console
  console.warn("[realtime-ws.test] `ws` package not installed; skipping integration tests");
}

const maybeTest = WS ? test : test.skip;

function waitForMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(new Error("timeout waiting for message"));
    }, timeoutMs);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(msg);
      }
    }
    ws.on("message", onMsg);
  });
}

async function setup() {
  const channels = createChannelRegistry();
  const server = http.createServer((_, res) => { res.statusCode = 404; res.end(); });
  const handle = mountRealtimeWs(server, {
    channels,
    // Bypass auth for tests — inject a resolver.
    resolveWsAuth: async () => ({ userId: "tester", workspaceId: "default" }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    channels,
    server,
    handle,
    url: `ws://127.0.0.1:${port}${REALTIME_WS_PATH}`,
    async teardown() {
      await handle.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

maybeTest("rejects upgrade when no auth and no resolver", async () => {
  const channels = createChannelRegistry();
  const server = http.createServer((_, res) => { res.statusCode = 404; res.end(); });
  // Force auth configuration to be "unsatisfied" by not injecting resolveWsAuth
  // and not setting USER_API_KEYS; isAuthConfigured() in the bare worktree may
  // return false (anonymous path). To exercise the 401 path deterministically,
  // inject a resolver that returns null.
  const handle = mountRealtimeWs(server, {
    channels,
    resolveWsAuth: async () => null,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `ws://127.0.0.1:${port}${REALTIME_WS_PATH}`;
  const ws = new WS(url);
  const errP = once(ws, "error").catch((e) => e);
  const closeP = once(ws, "close").catch(() => {});
  await Promise.race([errP, closeP]);
  assert.equal(ws.readyState === WS.CLOSED || ws.readyState === WS.CLOSING, true);
  await handle.close();
  await new Promise((resolve) => server.close(() => resolve()));
});

maybeTest("subscribe receives live events published via the registry", async () => {
  const ctx = await setup();
  try {
    const ws = new WS(ctx.url);
    await waitForMessage(ws, (m) => m.type === "ack" && m.channel === "__hello__");
    ws.send(JSON.stringify({ type: "subscribe", channel: "chat:room1" }));
    await waitForMessage(ws, (m) => m.type === "ack" && m.channel === "chat:room1");
    const eventP = waitForMessage(ws, (m) => m.type === "event" && m.channel === "chat:room1");
    ctx.channels.publish("chat:room1", { text: "hello" });
    const ev = await eventP;
    assert.equal(ev.seq, 1);
    assert.deepEqual(ev.payload, { text: "hello" });
    ws.close();
    await once(ws, "close");
  } finally {
    await ctx.teardown();
  }
});

maybeTest("ping → pong", async () => {
  const ctx = await setup();
  try {
    const ws = new WS(ctx.url);
    await waitForMessage(ws, (m) => m.type === "ack" && m.channel === "__hello__");
    ws.send(JSON.stringify({ type: "ping" }));
    const pong = await waitForMessage(ws, (m) => m.type === "pong");
    assert.equal(pong.type, "pong");
    ws.close();
    await once(ws, "close");
  } finally {
    await ctx.teardown();
  }
});

maybeTest("unsubscribe stops further events on that channel", async () => {
  const ctx = await setup();
  try {
    const ws = new WS(ctx.url);
    await waitForMessage(ws, (m) => m.type === "ack" && m.channel === "__hello__");
    ws.send(JSON.stringify({ type: "subscribe", channel: "run:1" }));
    await waitForMessage(ws, (m) => m.type === "ack" && m.channel === "run:1");
    const first = waitForMessage(ws, (m) => m.type === "event" && m.channel === "run:1");
    ctx.channels.publish("run:1", { step: "a" });
    await first;
    ws.send(JSON.stringify({ type: "unsubscribe", channel: "run:1" }));
    await waitForMessage(ws, (m) => m.type === "ack" && m.channel === "run:1");
    // Publish again — we should NOT receive it. Use a short timeout.
    ctx.channels.publish("run:1", { step: "b" });
    let gotSecond = false;
    try {
      await waitForMessage(ws, (m) => m.type === "event" && m.channel === "run:1", 300);
      gotSecond = true;
    } catch { /* expected timeout */ }
    assert.equal(gotSecond, false);
    ws.close();
    await once(ws, "close");
  } finally {
    await ctx.teardown();
  }
});

maybeTest("reconnect with sinceSeq replays missed events", async () => {
  const ctx = await setup();
  try {
    // First connection: subscribe and collect seqs.
    const wsA = new WS(ctx.url);
    await waitForMessage(wsA, (m) => m.type === "ack" && m.channel === "__hello__");
    wsA.send(JSON.stringify({ type: "subscribe", channel: "chat:resume" }));
    await waitForMessage(wsA, (m) => m.type === "ack" && m.channel === "chat:resume");

    const firstP = waitForMessage(wsA, (m) => m.type === "event" && m.channel === "chat:resume");
    ctx.channels.publish("chat:resume", { n: 1 });
    const first = await firstP;
    assert.equal(first.seq, 1);

    // Drop the connection (simulate network blip).
    wsA.close();
    await once(wsA, "close");

    // While disconnected, more events are published.
    ctx.channels.publish("chat:resume", { n: 2 });
    ctx.channels.publish("chat:resume", { n: 3 });

    // Reconnect and resume from seq=1.
    const wsB = new WS(ctx.url);
    await waitForMessage(wsB, (m) => m.type === "ack" && m.channel === "__hello__");
    wsB.send(JSON.stringify({ type: "subscribe", channel: "chat:resume", sinceSeq: 1 }));

    const got = [];
    // Collect the ack + two replayed events.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout collecting resume events")), 2000);
      wsB.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === "event" && msg.channel === "chat:resume") {
          got.push(msg);
          if (got.length === 2) { clearTimeout(timer); resolve(); }
        }
      });
    });
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((m) => m.payload.n), [2, 3]);
    assert.deepEqual(got.map((m) => m.seq), [2, 3]);
    wsB.close();
    await once(wsB, "close");
  } finally {
    await ctx.teardown();
  }
});

maybeTest("bad JSON produces a BAD_MESSAGE error", async () => {
  const ctx = await setup();
  try {
    const ws = new WS(ctx.url);
    await waitForMessage(ws, (m) => m.type === "ack" && m.channel === "__hello__");
    ws.send("not json");
    const err = await waitForMessage(ws, (m) => m.type === "error");
    assert.equal(err.code, "BAD_MESSAGE");
    ws.close();
    await once(ws, "close");
  } finally {
    await ctx.teardown();
  }
});
