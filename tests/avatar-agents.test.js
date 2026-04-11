/**
 * Phase 49.3: Avatar agent tests.
 *
 * Isolates STORAGE_PATH to a tmpdir so persisted avatars, states, and session
 * maps do not bleed into the real data dir or leak between suites.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-avatar-agents-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  DEFAULT_AVATAR_MODELS,
  createAvatarConfig,
  getAvatarConfig,
  listAvatars,
  updateAvatarConfig,
  deleteAvatarConfig,
  setAvatarState,
  getAvatarState,
  computeLipSync,
  computeEmotionFromText,
  computeIdleAnimation,
  trackAvatarInSession,
  getSessionAvatars,
  untrackAvatarFromSession,
  lookAtPose,
  interpolatePose,
} = await import("../lib/avatar-agents.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("DEFAULT_AVATAR_MODELS exposes primitive presets", () => {
  assert.ok(DEFAULT_AVATAR_MODELS);
  for (const key of ["cube", "sphere", "capsule", "helper"]) {
    const preset = DEFAULT_AVATAR_MODELS[key];
    assert.ok(preset, `expected preset ${key}`);
    assert.equal(preset.type, "primitive");
    assert.ok(typeof preset.shape === "string" && preset.shape.length > 0);
    assert.match(preset.color, /^#[0-9a-fA-F]{6}$/);
  }
});

test("createAvatarConfig returns an ID with defaults", async () => {
  const cfg = await createAvatarConfig({
    agentId: "agent-a",
    workspaceId: "ws-1",
    userId: "user-1",
    modelRef: "capsule",
  });
  assert.ok(cfg);
  assert.ok(cfg.avatarId.startsWith("avatar_"));
  assert.equal(cfg.agentId, "agent-a");
  assert.equal(cfg.workspaceId, "ws-1");
  assert.equal(cfg.modelRef.type, "primitive");
  assert.equal(cfg.modelRef.shape, "capsule");
  assert.deepEqual(cfg.position, [0, 0, 0]);
  assert.deepEqual(cfg.rotation, [0, 0, 0]);
  assert.deepEqual(cfg.scale, [1, 1, 1]);
  assert.equal(cfg.voice.pitch, 1.0);
});

test("getAvatarConfig returns the saved config", async () => {
  const created = await createAvatarConfig({
    agentId: "agent-b",
    modelRef: { type: "glb", url: "https://example.com/a.glb" },
    position: [1, 2, 3],
    rotation: { x: 0, y: 1.5, z: 0 },
    scale: 2,
    metadata: { label: "researcher" },
  });
  const fetched = await getAvatarConfig(created.avatarId);
  assert.ok(fetched);
  assert.equal(fetched.avatarId, created.avatarId);
  assert.equal(fetched.modelRef.url, "https://example.com/a.glb");
  assert.deepEqual(fetched.position, [1, 2, 3]);
  assert.deepEqual(fetched.rotation, [0, 1.5, 0]);
  assert.deepEqual(fetched.scale, [2, 2, 2]);
  assert.equal(fetched.metadata.label, "researcher");
});

test("listAvatars filters by agentId and workspaceId", async () => {
  await createAvatarConfig({ agentId: "filter-a", workspaceId: "ws-x" });
  await createAvatarConfig({ agentId: "filter-a", workspaceId: "ws-y" });
  await createAvatarConfig({ agentId: "filter-b", workspaceId: "ws-x" });

  const byAgent = await listAvatars({ agentId: "filter-a" });
  assert.ok(byAgent.length >= 2);
  assert.ok(byAgent.every((a) => a.agentId === "filter-a"));

  const byWorkspace = await listAvatars({ workspaceId: "ws-x" });
  assert.ok(byWorkspace.length >= 2);
  assert.ok(byWorkspace.every((a) => a.workspaceId === "ws-x"));

  const both = await listAvatars({ agentId: "filter-a", workspaceId: "ws-y" });
  assert.ok(both.length >= 1);
  assert.ok(both.every((a) => a.agentId === "filter-a" && a.workspaceId === "ws-y"));
});

test("updateAvatarConfig merges fields and preserves others", async () => {
  const created = await createAvatarConfig({
    agentId: "agent-upd",
    modelRef: "sphere",
    voice: { pitch: 1.2, rate: 1.1 },
    metadata: { mode: "static" },
  });

  const updated = await updateAvatarConfig(created.avatarId, {
    position: [5, 0, -5],
    voice: { pitch: 0.9 },
    metadata: { mood: "curious" },
  });

  assert.ok(updated);
  assert.deepEqual(updated.position, [5, 0, -5]);
  assert.equal(updated.voice.pitch, 0.9);
  // rate should remain from prior value
  assert.equal(updated.voice.rate, 1.1);
  // original metadata key preserved
  assert.equal(updated.metadata.mode, "static");
  assert.equal(updated.metadata.mood, "curious");
  assert.notEqual(updated.updatedAt, created.updatedAt);
});

test("deleteAvatarConfig removes the record", async () => {
  const created = await createAvatarConfig({ agentId: "to-delete" });
  const before = await getAvatarConfig(created.avatarId);
  assert.ok(before);
  const result = await deleteAvatarConfig(created.avatarId);
  assert.equal(result.ok, true);
  const after = await getAvatarConfig(created.avatarId);
  assert.equal(after, null);
});

test("setAvatarState and getAvatarState round-trip", async () => {
  const created = await createAvatarConfig({ agentId: "state-test" });
  const state = await setAvatarState(created.avatarId, {
    mood: "happy",
    animation: "talking",
    lookAt: [0, 1.5, 2],
    speaking: true,
    gesture: "wave",
  });
  assert.equal(state.mood, "happy");
  assert.equal(state.animation, "talking");
  assert.deepEqual(state.lookAt, [0, 1.5, 2]);
  assert.equal(state.speaking, true);
  assert.equal(state.gesture, "wave");

  const fetched = await getAvatarState(created.avatarId);
  assert.ok(fetched);
  assert.equal(fetched.mood, "happy");
  assert.equal(fetched.animation, "talking");

  // Invalid mood should fall back to neutral
  const coerced = await setAvatarState(created.avatarId, { mood: "not-a-mood" });
  assert.equal(coerced.mood, "neutral");
});

test("computeLipSync returns an array of visemes with times and weights", () => {
  const frames = computeLipSync({ durationMs: 2000, text: "hello world from siskelbot" });
  assert.ok(Array.isArray(frames));
  assert.ok(frames.length > 5);
  for (const frame of frames) {
    assert.equal(typeof frame.time, "number");
    assert.equal(typeof frame.viseme, "string");
    assert.equal(typeof frame.weight, "number");
    assert.ok(frame.weight >= 0 && frame.weight <= 1);
  }
  // Tail frame should be silent
  const last = frames[frames.length - 1];
  assert.equal(last.weight, 0);

  // Envelope-driven path
  const envFrames = computeLipSync({ durationMs: 500, envelope: [0.1, 0.5, 0.9, 0.4, 0.0] }, "classic");
  assert.ok(envFrames.length >= 5);
  assert.ok(envFrames.every((f) => typeof f.viseme === "string"));
});

test("computeEmotionFromText detects positive mood", () => {
  const result = computeEmotionFromText("This is wonderful and amazing, I love it, thanks!");
  assert.equal(result.primary, "happy");
  assert.ok(result.confidence > 0.3);
  assert.ok(result.scores.happy >= 3);
});

test("computeEmotionFromText detects negative mood", () => {
  const result = computeEmotionFromText("I am sad and disappointed, this is terrible and awful.");
  assert.equal(result.primary, "sad");
  assert.ok(result.confidence > 0.3);
  assert.ok((result.scores.sad || 0) >= 2);
});

test("computeEmotionFromText returns neutral for empty input", () => {
  const result = computeEmotionFromText("");
  assert.equal(result.primary, "neutral");
  assert.equal(result.confidence, 0);

  const unknown = computeEmotionFromText("the quick brown fox jumps");
  assert.equal(unknown.primary, "neutral");
});

test("computeIdleAnimation is deterministic per seed and time", () => {
  const a1 = computeIdleAnimation("agent-123", 1.5);
  const a2 = computeIdleAnimation("agent-123", 1.5);
  assert.deepEqual(a1, a2);

  const b1 = computeIdleAnimation("agent-456", 1.5);
  assert.notDeepEqual(a1, b1);

  // Check fields in expected ranges
  for (const sample of [a1, b1]) {
    assert.ok(Number.isFinite(sample.headPitch));
    assert.ok(Number.isFinite(sample.headYaw));
    assert.ok(sample.breathPhase >= 0 && sample.breathPhase <= 1);
  }
});

test("trackAvatarInSession and getSessionAvatars track multi-agent scenes", async () => {
  const a = await createAvatarConfig({ agentId: "scene-a" });
  const b = await createAvatarConfig({ agentId: "scene-b" });
  const sessionId = "sess-123";
  const r1 = await trackAvatarInSession(sessionId, a.avatarId);
  assert.deepEqual(r1.avatarIds, [a.avatarId]);
  const r2 = await trackAvatarInSession(sessionId, b.avatarId);
  assert.equal(r2.avatarIds.length, 2);

  // Duplicate tracking is idempotent
  const r3 = await trackAvatarInSession(sessionId, a.avatarId);
  assert.equal(r3.avatarIds.length, 2);

  const scene = await getSessionAvatars(sessionId);
  assert.equal(scene.length, 2);
  const ids = scene.map((s) => s.avatarId);
  assert.ok(ids.includes(a.avatarId));
  assert.ok(ids.includes(b.avatarId));

  const removed = await untrackAvatarFromSession(sessionId, a.avatarId);
  assert.equal(removed.avatarIds.length, 1);
});

test("getSessionAvatars returns empty list for unknown session", async () => {
  const scene = await getSessionAvatars("no-such-session");
  assert.deepEqual(scene, []);
});

test("lookAtPose returns normalized forward vector and euler angles", () => {
  const pose = lookAtPose([0, 0, 0], [0, 0, 10]);
  const mag = Math.hypot(pose.forward[0], pose.forward[1], pose.forward[2]);
  assert.ok(Math.abs(mag - 1) < 1e-6);
  assert.ok(Math.abs(pose.forward[2] - 1) < 1e-6);
  assert.equal(pose.yaw, 0);
  assert.equal(pose.pitch, 0);
  assert.equal(pose.length, 10);

  // Look left — yaw should be negative-ish or positive depending on axis convention; just check magnitude
  const left = lookAtPose([0, 0, 0], [-10, 0, 0]);
  assert.ok(Math.abs(left.yaw) > 0.1);
  // Equal from/target returns zero-length forward fallback
  const degenerate = lookAtPose([1, 1, 1], [1, 1, 1]);
  assert.equal(degenerate.length, 0);
});

test("interpolatePose computes midpoint values", () => {
  const from = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const to = { position: [10, 20, 30], rotation: [1, 2, 3], scale: [2, 2, 2] };
  const mid = interpolatePose(from, to, 0.5);
  assert.deepEqual(mid.position, [5, 10, 15]);
  assert.deepEqual(mid.rotation, [0.5, 1, 1.5]);
  assert.deepEqual(mid.scale, [1.5, 1.5, 1.5]);

  const start = interpolatePose(from, to, 0);
  assert.deepEqual(start.position, [0, 0, 0]);
  const end = interpolatePose(from, to, 1);
  assert.deepEqual(end.position, [10, 20, 30]);

  // Out-of-range clamps
  const clamped = interpolatePose(from, to, 5);
  assert.deepEqual(clamped.position, [10, 20, 30]);
});

test("cascade delete removes state and session references", async () => {
  const cfg = await createAvatarConfig({ agentId: "cascade" });
  await setAvatarState(cfg.avatarId, { mood: "focused" });
  await trackAvatarInSession("cascade-sess", cfg.avatarId);

  await deleteAvatarConfig(cfg.avatarId);

  const state = await getAvatarState(cfg.avatarId);
  assert.equal(state, null);
  const scene = await getSessionAvatars("cascade-sess");
  assert.equal(scene.length, 0);
});
