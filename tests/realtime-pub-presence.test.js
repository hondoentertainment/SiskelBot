/**
 * Verifies that presence join/leave events are additively published to the
 * unified realtime channel registry at `presence:<workspaceId>`.
 *
 * This exercises `publishPresenceEvent` directly — it's the same helper used
 * inside the WebSocket connection/disconnection handlers in lib/realtime.js,
 * so the shape guarantee covers both sites without spinning up a real
 * WebSocketServer (which would require the optional `ws` dependency).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { publishPresenceEvent } from "../lib/realtime.js";
import { defaultChannelRegistry } from "../lib/realtime-channels.js";

test("publishPresenceEvent('join', ...) publishes to presence:<workspaceId>", () => {
  const workspaceId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const channel = `presence:${workspaceId}`;

  const received = [];
  defaultChannelRegistry.subscribe(channel, "presence-sub-1", (ev) => received.push(ev));

  const before = Date.now();
  publishPresenceEvent("join", workspaceId, "alice");
  const after = Date.now();

  assert.equal(received.length, 1);
  const ev = received[0];
  assert.equal(ev.channel, channel);
  assert.equal(ev.payload.type, "join");
  assert.equal(ev.payload.userId, "alice");
  assert.equal(typeof ev.payload.ts, "number");
  assert.ok(
    ev.payload.ts >= before && ev.payload.ts <= after,
    "ts falls within the invocation window"
  );

  defaultChannelRegistry.unsubscribe(channel, "presence-sub-1");
});

test("publishPresenceEvent('leave', ...) publishes to presence:<workspaceId>", () => {
  const workspaceId = `ws-leave-${Date.now()}`;
  const channel = `presence:${workspaceId}`;

  const received = [];
  defaultChannelRegistry.subscribe(channel, "presence-sub-2", (ev) => received.push(ev));

  publishPresenceEvent("leave", workspaceId, "bob");

  assert.equal(received.length, 1);
  const ev = received[0];
  assert.equal(ev.channel, channel);
  assert.equal(ev.payload.type, "leave");
  assert.equal(ev.payload.userId, "bob");
  assert.equal(typeof ev.payload.ts, "number");

  defaultChannelRegistry.unsubscribe(channel, "presence-sub-2");
});

test("join then leave produces two events with monotonic seq", () => {
  const workspaceId = `ws-pair-${Date.now()}`;
  const channel = `presence:${workspaceId}`;

  const received = [];
  defaultChannelRegistry.subscribe(channel, "presence-sub-3", (ev) => received.push(ev));

  publishPresenceEvent("join", workspaceId, "carol");
  publishPresenceEvent("leave", workspaceId, "carol");

  assert.equal(received.length, 2);
  assert.equal(received[0].payload.type, "join");
  assert.equal(received[1].payload.type, "leave");
  assert.equal(received[0].payload.userId, "carol");
  assert.equal(received[1].payload.userId, "carol");
  assert.ok(received[1].seq > received[0].seq, "seq is monotonic within channel");

  defaultChannelRegistry.unsubscribe(channel, "presence-sub-3");
});

test("events for different workspaces are isolated by channel", () => {
  const wsA = `ws-iso-A-${Date.now()}`;
  const wsB = `ws-iso-B-${Date.now()}`;
  const receivedA = [];
  const receivedB = [];

  defaultChannelRegistry.subscribe(`presence:${wsA}`, "iso-A", (ev) => receivedA.push(ev));
  defaultChannelRegistry.subscribe(`presence:${wsB}`, "iso-B", (ev) => receivedB.push(ev));

  publishPresenceEvent("join", wsA, "u1");
  publishPresenceEvent("join", wsB, "u2");
  publishPresenceEvent("leave", wsA, "u1");

  assert.equal(receivedA.length, 2);
  assert.equal(receivedB.length, 1);
  assert.equal(receivedA.map((e) => e.payload.type).join(","), "join,leave");
  assert.equal(receivedB[0].payload.userId, "u2");

  defaultChannelRegistry.unsubscribe(`presence:${wsA}`, "iso-A");
  defaultChannelRegistry.unsubscribe(`presence:${wsB}`, "iso-B");
});

test("publishPresenceEvent swallows subscriber errors (never throws)", () => {
  const workspaceId = `ws-err-${Date.now()}`;
  const channel = `presence:${workspaceId}`;

  defaultChannelRegistry.subscribe(channel, "bad-sub", () => {
    throw new Error("subscriber boom");
  });

  // Must not throw.
  assert.doesNotThrow(() => publishPresenceEvent("join", workspaceId, "dave"));

  defaultChannelRegistry.unsubscribe(channel, "bad-sub");
});
