/**
 * Phase 49.5: Collaborative VR rooms tests.
 *
 * Covers lifecycle (create/get/list/update/delete), participants (join, leave,
 * capacity), pose sync, shared scene objects, voice state, and spawn layout.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so persisted state does not pollute the
// project data dir or leak between suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-vr-rooms-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createRoom,
  getRoom,
  listRooms,
  updateRoom,
  deleteRoom,
  joinRoom,
  leaveRoom,
  getParticipants,
  updateParticipantPose,
  getParticipantPose,
  spawnObject,
  updateObject,
  removeObject,
  getRoomObjects,
  setVoiceState,
  computeSpawnPosition,
  checkCapacity,
  buildRoomEvent,
} = await import("../lib/vr-rooms.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- Rooms ----

test("createRoom returns a roomId and persists metadata", async () => {
  const room = await createRoom({
    name: "Alpha Lab",
    workspaceId: "ws-1",
    maxParticipants: 8,
    isPublic: true,
    theme: "cyber",
  });
  assert.ok(room.roomId.startsWith("room_"));
  assert.equal(room.name, "Alpha Lab");
  assert.equal(room.workspaceId, "ws-1");
  assert.equal(room.maxParticipants, 8);
  assert.equal(room.isPublic, true);
  assert.equal(room.theme, "cyber");
  assert.ok(room.createdAt > 0);
});

test("createRoom rejects empty name", async () => {
  await assert.rejects(() => createRoom({ name: "" }), /name is required/);
});

test("getRoom returns the saved room and null for unknown ids", async () => {
  const created = await createRoom({ name: "Beta Hall", workspaceId: "ws-1" });
  const loaded = await getRoom(created.roomId);
  assert.equal(loaded.roomId, created.roomId);
  assert.equal(loaded.name, "Beta Hall");
  const missing = await getRoom("room_doesnotexist");
  assert.equal(missing, null);
});

test("listRooms can filter by workspaceId", async () => {
  await createRoom({ name: "Gamma", workspaceId: "ws-A" });
  await createRoom({ name: "Delta", workspaceId: "ws-B" });
  const wsA = await listRooms({ workspaceId: "ws-A" });
  assert.ok(wsA.every((r) => r.workspaceId === "ws-A"));
  assert.ok(wsA.some((r) => r.name === "Gamma"));
  const all = await listRooms();
  assert.ok(all.length >= 2);
});

test("updateRoom merges updates and bumps updatedAt", async () => {
  const room = await createRoom({ name: "Epsilon", workspaceId: "ws-u" });
  // Delay so updatedAt is strictly greater.
  await new Promise((r) => setTimeout(r, 2));
  const updated = await updateRoom(room.roomId, {
    name: "Epsilon Renamed",
    theme: "neon",
    maxParticipants: 32,
    isPublic: false,
  });
  assert.equal(updated.name, "Epsilon Renamed");
  assert.equal(updated.theme, "neon");
  assert.equal(updated.maxParticipants, 32);
  assert.equal(updated.isPublic, false);
  assert.ok(updated.updatedAt >= room.updatedAt);
});

test("updateRoom throws for unknown room", async () => {
  await assert.rejects(() => updateRoom("room_none", { name: "x" }), /not found/);
});

test("deleteRoom removes the room", async () => {
  const room = await createRoom({ name: "Zeta", workspaceId: "ws-d" });
  const ok = await deleteRoom(room.roomId);
  assert.equal(ok, true);
  const loaded = await getRoom(room.roomId);
  assert.equal(loaded, null);
});

// ---- Participants ----

test("joinRoom returns participantId and token", async () => {
  const room = await createRoom({ name: "Eta", workspaceId: "ws-p" });
  const join = await joinRoom(room.roomId, "user-1", "Alice", "avatar-red");
  assert.ok(join.participantId.startsWith("p_"));
  assert.ok(typeof join.token === "string" && join.token.length > 0);
  assert.ok(Array.isArray(join.spawnPosition) && join.spawnPosition.length === 3);
  assert.equal(join.room.participants[join.participantId].displayName, "Alice");
});

test("joinRoom respects maxParticipants", async () => {
  const room = await createRoom({ name: "Theta", workspaceId: "ws-cap", maxParticipants: 2 });
  await joinRoom(room.roomId, "u1", "One");
  await joinRoom(room.roomId, "u2", "Two");
  await assert.rejects(
    () => joinRoom(room.roomId, "u3", "Three"),
    /at capacity/,
  );
});

test("leaveRoom removes the participant", async () => {
  const room = await createRoom({ name: "Iota", workspaceId: "ws-l" });
  const j = await joinRoom(room.roomId, "user-x", "Xavier");
  const left = await leaveRoom(room.roomId, j.participantId);
  assert.equal(left, true);
  const parts = await getParticipants(room.roomId);
  assert.equal(parts.find((p) => p.participantId === j.participantId), undefined);
});

test("getParticipants lists active participants without tokens", async () => {
  const room = await createRoom({ name: "Kappa", workspaceId: "ws-list" });
  await joinRoom(room.roomId, "u-a", "A");
  await joinRoom(room.roomId, "u-b", "B");
  const parts = await getParticipants(room.roomId);
  assert.equal(parts.length, 2);
  for (const p of parts) {
    assert.equal(p.token, undefined);
    assert.ok(p.participantId);
    assert.ok(p.joinedAt > 0);
  }
});

// ---- Pose sync ----

test("updateParticipantPose and getParticipantPose round-trip", async () => {
  const room = await createRoom({ name: "Lambda", workspaceId: "ws-pose" });
  const j = await joinRoom(room.roomId, "u-pose", "Poser");
  const pose = {
    head: { position: [1, 1.7, -2], rotation: [0, 0, 0, 1] },
    hands: {
      left: { position: [0.5, 1.2, -2], rotation: [0, 0, 0, 1] },
      right: { position: [1.5, 1.2, -2], rotation: [0, 0, 0, 1] },
    },
    velocity: [0.1, 0, 0],
  };
  const saved = await updateParticipantPose(room.roomId, j.participantId, pose);
  assert.deepEqual(saved.head.position, [1, 1.7, -2]);
  const loaded = await getParticipantPose(room.roomId, j.participantId);
  assert.deepEqual(loaded.head.position, [1, 1.7, -2]);
  assert.deepEqual(loaded.velocity, [0.1, 0, 0]);
});

test("updateParticipantPose throws for missing room or participant", async () => {
  await assert.rejects(
    () => updateParticipantPose("room_none", "p_none", {}),
    /not found/,
  );
  const room = await createRoom({ name: "LambdaX", workspaceId: "ws-pose-x" });
  await assert.rejects(
    () => updateParticipantPose(room.roomId, "p_ghost", {}),
    /participant .* not found/,
  );
});

// ---- Shared objects ----

test("spawnObject stores with an objectId", async () => {
  const room = await createRoom({ name: "Mu", workspaceId: "ws-obj" });
  const obj = await spawnObject(room.roomId, {
    type: "cube",
    position: [0, 1, 0],
    rotation: [0, 0, 0, 1],
    owner: "user-o",
    properties: { color: "red" },
  });
  assert.ok(obj.objectId.startsWith("obj_"));
  assert.equal(obj.type, "cube");
  assert.equal(obj.owner, "user-o");
  assert.equal(obj.properties.color, "red");
});

test("spawnObject requires a type", async () => {
  const room = await createRoom({ name: "MuBad", workspaceId: "ws-obj-bad" });
  await assert.rejects(
    () => spawnObject(room.roomId, { position: [0, 0, 0] }),
    /type is required/,
  );
});

test("updateObject merges fields", async () => {
  const room = await createRoom({ name: "Nu", workspaceId: "ws-upd" });
  const obj = await spawnObject(room.roomId, {
    type: "sphere",
    position: [0, 1, 0],
    properties: { color: "blue", radius: 1 },
  });
  const merged = await updateObject(room.roomId, obj.objectId, {
    position: [1, 2, 3],
    properties: { color: "green" },
  });
  assert.deepEqual(merged.position, [1, 2, 3]);
  assert.equal(merged.properties.color, "green");
  // Previous properties preserved through merge.
  assert.equal(merged.properties.radius, 1);
});

test("removeObject deletes the object", async () => {
  const room = await createRoom({ name: "Xi", workspaceId: "ws-rm" });
  const obj = await spawnObject(room.roomId, { type: "marker" });
  const removed = await removeObject(room.roomId, obj.objectId);
  assert.equal(removed, true);
  const objs = await getRoomObjects(room.roomId);
  assert.equal(objs.length, 0);
});

test("getRoomObjects lists all objects", async () => {
  const room = await createRoom({ name: "Omicron", workspaceId: "ws-many" });
  await spawnObject(room.roomId, { type: "cube" });
  await spawnObject(room.roomId, { type: "sphere" });
  await spawnObject(room.roomId, { type: "light" });
  const objs = await getRoomObjects(room.roomId);
  assert.equal(objs.length, 3);
  const types = objs.map((o) => o.type).sort();
  assert.deepEqual(types, ["cube", "light", "sphere"]);
});

// ---- Voice ----

test("setVoiceState updates muted, speaking and volume", async () => {
  const room = await createRoom({ name: "Pi", workspaceId: "ws-v" });
  const j = await joinRoom(room.roomId, "u-v", "Voicer");
  const state = await setVoiceState(room.roomId, j.participantId, {
    muted: true,
    speaking: false,
    volume: 0.25,
  });
  assert.equal(state.muted, true);
  assert.equal(state.speaking, false);
  assert.equal(state.volume, 0.25);
  const state2 = await setVoiceState(room.roomId, j.participantId, { muted: false });
  assert.equal(state2.muted, false);
  // Previously-set values should persist through partial updates.
  assert.equal(state2.volume, 0.25);
});

// ---- Spawn positions ----

test("computeSpawnPosition produces non-overlapping positions", () => {
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    const pos = computeSpawnPosition(i, "circle");
    assert.equal(pos.length, 3);
    const key = pos.map((n) => Number(n).toFixed(4)).join(",");
    assert.ok(!seen.has(key), `duplicate spawn at index ${i}: ${key}`);
    seen.add(key);
  }
});

test("computeSpawnPosition supports grid and line layouts", () => {
  const g = computeSpawnPosition(4, "grid");
  assert.equal(g.length, 3);
  const l = computeSpawnPosition(2, "line");
  assert.equal(l.length, 3);
});

// ---- Capacity and events ----

test("checkCapacity reports current, max and full", async () => {
  const room = await createRoom({ name: "Rho", workspaceId: "ws-cap2", maxParticipants: 2 });
  let cap = await checkCapacity(room.roomId);
  assert.equal(cap.current, 0);
  assert.equal(cap.max, 2);
  assert.equal(cap.full, false);
  await joinRoom(room.roomId, "u1", "One");
  await joinRoom(room.roomId, "u2", "Two");
  cap = await checkCapacity(room.roomId);
  assert.equal(cap.current, 2);
  assert.equal(cap.full, true);
});

test("buildRoomEvent returns a structured payload", () => {
  const ev = buildRoomEvent("vr.pose.update", "room_abc", { hello: "world" });
  assert.equal(ev.type, "vr.pose.update");
  assert.equal(ev.roomId, "room_abc");
  assert.equal(ev.channel, "vr-room:room_abc");
  assert.deepEqual(ev.payload, { hello: "world" });
  assert.ok(ev.at > 0);
});
