/**
 * Phase 41.5: tests for the WebRTC signaling registry.
 *
 * The signaling layer is a small pure-JS module — no DOM, no real WebRTC
 * APIs — so we can drive it directly with stub transports.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSignalingServer, globalSignaling } from "../lib/webrtc-signaling.js";

function captureTransport() {
  const messages = [];
  return {
    fn: (msg) => messages.push(msg),
    messages,
  };
}

test("createRoom registers the host and returns metadata", () => {
  const sig = createSignalingServer();
  const room = sig.createRoom("room-1", "host-session", {
    workspaceId: "ws-1",
    hostUserId: "alice",
    title: "Pair programming",
  });

  assert.equal(room.id, "room-1");
  assert.equal(room.workspaceId, "ws-1");
  assert.equal(room.hostUserId, "alice");
  assert.equal(room.title, "Pair programming");
  assert.deepEqual(room.participants, ["host-session"]);
  assert.equal(room.participantCount, 1);
});

test("createRoom auto-generates id when not provided", () => {
  const sig = createSignalingServer();
  const room = sig.createRoom(null, "host-session");
  assert.ok(room.id && typeof room.id === "string");
  assert.equal(room.hostSessionId, "host-session");
});

test("createRoom rejects duplicate room ids", () => {
  const sig = createSignalingServer();
  sig.createRoom("dup", "host-1");
  assert.throws(() => sig.createRoom("dup", "host-2"), /already exists/);
});

test("createRoom requires a hostSessionId", () => {
  const sig = createSignalingServer();
  assert.throws(() => sig.createRoom("room-x", null), /hostSessionId/);
});

test("joinRoom adds viewer and notifies host with peer_joined", () => {
  const sig = createSignalingServer();
  const hostT = captureTransport();
  sig.registerTransport("host-1", hostT.fn);
  sig.createRoom("room-2", "host-1", { hostUserId: "alice" });

  const viewerT = captureTransport();
  sig.registerTransport("viewer-1", viewerT.fn);
  const room = sig.joinRoom("room-2", "viewer-1", { userId: "bob" });

  assert.equal(room.participantCount, 2);
  assert.ok(room.participants.includes("viewer-1"));

  // Host should have received the peer_joined notification.
  const peerJoined = hostT.messages.find((m) => m.type === "peer_joined");
  assert.ok(peerJoined);
  assert.equal(peerJoined.sessionId, "viewer-1");
  assert.equal(peerJoined.userId, "bob");
  assert.equal(peerJoined.roomId, "room-2");
});

test("joinRoom throws when room does not exist", () => {
  const sig = createSignalingServer();
  assert.throws(() => sig.joinRoom("missing", "viewer-1"), /not found/);
});

test("joining a second room force-leaves the first", () => {
  const sig = createSignalingServer();
  sig.createRoom("room-a", "host-a");
  sig.createRoom("room-b", "host-b");
  const viewerT = captureTransport();
  sig.registerTransport("viewer-1", viewerT.fn);

  sig.joinRoom("room-a", "viewer-1");
  sig.joinRoom("room-b", "viewer-1");

  assert.equal(sig.getRoom("room-a").participantCount, 1); // only host
  assert.equal(sig.getRoom("room-b").participantCount, 2);
});

test("handleSignal relays offer/answer between sessions in the same room", () => {
  const sig = createSignalingServer();
  const hostT = captureTransport();
  const viewerT = captureTransport();
  sig.registerTransport("host-1", hostT.fn);
  sig.registerTransport("viewer-1", viewerT.fn);

  sig.createRoom("room-3", "host-1");
  sig.joinRoom("room-3", "viewer-1");

  // Host sends offer to viewer.
  sig.handleSignal("host-1", "viewer-1", { type: "offer", sdp: "v=0..." });
  const offer = viewerT.messages.find((m) => m.type === "webrtc_signal" && m.signal.type === "offer");
  assert.ok(offer);
  assert.equal(offer.from, "host-1");
  assert.equal(offer.to, "viewer-1");
  assert.equal(offer.signal.sdp, "v=0...");

  // Viewer answers.
  sig.handleSignal("viewer-1", "host-1", { type: "answer", sdp: "v=0...answer" });
  const answer = hostT.messages.find((m) => m.type === "webrtc_signal" && m.signal.type === "answer");
  assert.ok(answer);
  assert.equal(answer.signal.sdp, "v=0...answer");
});

test("handleSignal relays ICE candidates", () => {
  const sig = createSignalingServer();
  const hostT = captureTransport();
  const viewerT = captureTransport();
  sig.registerTransport("h", hostT.fn);
  sig.registerTransport("v", viewerT.fn);
  sig.createRoom("ice-room", "h");
  sig.joinRoom("ice-room", "v");

  sig.handleSignal("h", "v", { type: "ice", candidate: { candidate: "candidate:1 1 udp..." } });
  const ice = viewerT.messages.find((m) => m.signal && m.signal.type === "ice");
  assert.ok(ice);
  assert.equal(ice.signal.candidate.candidate.startsWith("candidate:1"), true);
});

test("handleSignal rejects cross-room signaling", () => {
  const sig = createSignalingServer();
  sig.createRoom("room-x", "host-x");
  sig.createRoom("room-y", "host-y");
  assert.throws(
    () => sig.handleSignal("host-x", "host-y", { type: "offer", sdp: "..." }),
    /not in the same room/
  );
});

test("handleSignal validates session existence", () => {
  const sig = createSignalingServer();
  sig.createRoom("r", "h");
  assert.throws(() => sig.handleSignal("h", "ghost", { type: "offer" }), /Unknown recipient/);
  assert.throws(() => sig.handleSignal("ghost", "h", { type: "offer" }), /Unknown sender/);
});

test("multiple viewers can be in the same room", () => {
  const sig = createSignalingServer();
  const host = captureTransport();
  const v1 = captureTransport();
  const v2 = captureTransport();
  const v3 = captureTransport();
  sig.registerTransport("host", host.fn);
  sig.registerTransport("v1", v1.fn);
  sig.registerTransport("v2", v2.fn);
  sig.registerTransport("v3", v3.fn);

  sig.createRoom("multi", "host");
  sig.joinRoom("multi", "v1");
  sig.joinRoom("multi", "v2");
  sig.joinRoom("multi", "v3");

  const participants = sig.getRoomParticipants("multi");
  assert.equal(participants.length, 4);
  const roles = participants.map((p) => p.role).sort();
  assert.deepEqual(roles, ["host", "viewer", "viewer", "viewer"]);

  // Host should have been notified about each viewer joining.
  const joins = host.messages.filter((m) => m.type === "peer_joined");
  assert.equal(joins.length, 3);

  // Earlier viewers should have been told about later joiners.
  const v1Joins = v1.messages.filter((m) => m.type === "peer_joined").map((m) => m.sessionId);
  assert.deepEqual(v1Joins.sort(), ["v2", "v3"]);
});

test("leaveRoom removes a viewer and notifies remaining peers", () => {
  const sig = createSignalingServer();
  const host = captureTransport();
  const v1 = captureTransport();
  const v2 = captureTransport();
  sig.registerTransport("host", host.fn);
  sig.registerTransport("v1", v1.fn);
  sig.registerTransport("v2", v2.fn);

  sig.createRoom("leave-room", "host");
  sig.joinRoom("leave-room", "v1", { userId: "bob" });
  sig.joinRoom("leave-room", "v2", { userId: "carol" });

  const result = sig.leaveRoom("v1");
  assert.equal(result.roomClosed, false);
  assert.equal(sig.getRoom("leave-room").participantCount, 2);

  const peerLeft = host.messages.find((m) => m.type === "peer_left" && m.sessionId === "v1");
  assert.ok(peerLeft);
  assert.equal(peerLeft.userId, "bob");
});

test("leaveRoom by host collapses the room and notifies viewers", () => {
  const sig = createSignalingServer();
  const host = captureTransport();
  const v1 = captureTransport();
  const v2 = captureTransport();
  sig.registerTransport("host", host.fn);
  sig.registerTransport("v1", v1.fn);
  sig.registerTransport("v2", v2.fn);

  sig.createRoom("host-leave", "host");
  sig.joinRoom("host-leave", "v1");
  sig.joinRoom("host-leave", "v2");

  const result = sig.leaveRoom("host");
  assert.equal(result.roomClosed, true);
  assert.equal(sig.getRoom("host-leave"), null);

  const v1End = v1.messages.find((m) => m.type === "screen_share_ended");
  const v2End = v2.messages.find((m) => m.type === "screen_share_ended");
  assert.ok(v1End);
  assert.ok(v2End);
  assert.equal(v1End.reason, "host_left");
});

test("leaveRoom is a no-op for unknown sessions", () => {
  const sig = createSignalingServer();
  assert.equal(sig.leaveRoom("nobody"), null);
});

test("closeRoom notifies all participants and removes the room", () => {
  const sig = createSignalingServer();
  const host = captureTransport();
  const v1 = captureTransport();
  sig.registerTransport("host", host.fn);
  sig.registerTransport("v1", v1.fn);

  sig.createRoom("close-room", "host");
  sig.joinRoom("close-room", "v1");

  assert.equal(sig.closeRoom("close-room", "admin_action"), true);
  assert.equal(sig.getRoom("close-room"), null);

  const ended = v1.messages.find((m) => m.type === "screen_share_ended");
  assert.ok(ended);
  assert.equal(ended.reason, "admin_action");
});

test("closeRoom returns false when the room does not exist", () => {
  const sig = createSignalingServer();
  assert.equal(sig.closeRoom("missing"), false);
});

test("listRooms filters by workspaceId", () => {
  const sig = createSignalingServer();
  sig.createRoom("ws1-a", "h1", { workspaceId: "ws-1" });
  sig.createRoom("ws1-b", "h2", { workspaceId: "ws-1" });
  sig.createRoom("ws2-a", "h3", { workspaceId: "ws-2" });

  const ws1 = sig.listRooms("ws-1");
  const ws2 = sig.listRooms("ws-2");
  const all = sig.listRooms();

  assert.equal(ws1.length, 2);
  assert.equal(ws2.length, 1);
  assert.equal(all.length, 3);
});

test("queued messages are flushed when transport is registered later", () => {
  const sig = createSignalingServer();
  // Host has a transport, viewer does not yet.
  const host = captureTransport();
  sig.registerTransport("h", host.fn);
  sig.createRoom("queue-room", "h");
  sig.joinRoom("queue-room", "v");

  // Send a signal from host to viewer before viewer transport is registered.
  sig.handleSignal("h", "v", { type: "offer", sdp: "v=0..." });

  const v = captureTransport();
  sig.registerTransport("v", v.fn);

  // The queued offer should now have been delivered.
  const offer = v.messages.find((m) => m.type === "webrtc_signal" && m.signal.type === "offer");
  assert.ok(offer);
});

test("disconnect cleanup: leaveRoom + unregisterTransport remove all state", () => {
  const sig = createSignalingServer();
  const host = captureTransport();
  const v1 = captureTransport();
  sig.registerTransport("h", host.fn);
  sig.registerTransport("v1", v1.fn);
  sig.createRoom("cleanup-room", "h");
  sig.joinRoom("cleanup-room", "v1");

  // Simulate viewer disconnect.
  sig.leaveRoom("v1");
  sig.unregisterTransport("v1");

  const room = sig.getRoom("cleanup-room");
  assert.ok(room);
  assert.equal(room.participantCount, 1); // host only
  assert.deepEqual(room.participants, ["h"]);

  // Now host disconnects.
  sig.leaveRoom("h");
  sig.unregisterTransport("h");
  assert.equal(sig.getRoom("cleanup-room"), null);
  assert.equal(sig._stats().rooms, 0);
  assert.equal(sig._stats().sessions, 0);
});

test("getRoomParticipants returns empty array for unknown room", () => {
  const sig = createSignalingServer();
  assert.deepEqual(sig.getRoomParticipants("missing"), []);
});

test("globalSignaling singleton is usable", () => {
  const id = "global-test-" + Math.random().toString(36).slice(2);
  const room = globalSignaling.createRoom(id, "global-host");
  try {
    assert.equal(room.id, id);
    const fetched = globalSignaling.getRoom(id);
    assert.ok(fetched);
  } finally {
    globalSignaling.closeRoom(id);
  }
});
