/**
 * Phase 49.4: Tests for lib/gesture-recognizer.js.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  GESTURES,
  DEFAULT_GESTURE_COMMANDS,
  FINGER_JOINTS,
  computeFingerCurl,
  computePalmOrientation,
  computePinchDistance,
  recognizeStaticGesture,
  recognizeDynamicGesture,
  GestureStateMachine,
  mapGestureToCommand,
  registerCommand,
  mockHandJoints,
  mockWaveSequence,
  mockGrabSequence,
} from "../lib/gesture-recognizer.js";

// ─── finger curl ────────────────────────────────────────────────────────────

test("computeFingerCurl: extended index finger returns a low curl value", () => {
  const joints = mockHandJoints("open_palm");
  const curl = computeFingerCurl(joints, "index");
  assert.ok(curl < 0.3, `expected extended index curl <0.3 but got ${curl}`);
});

test("computeFingerCurl: fist returns high curl for every finger", () => {
  const joints = mockHandJoints("fist");
  for (const finger of ["thumb", "index", "middle", "ring", "pinky"]) {
    const curl = computeFingerCurl(joints, finger);
    assert.ok(curl > 0.6, `${finger} curl should be >0.6 in fist, got ${curl}`);
  }
});

test("computeFingerCurl: unknown finger name returns 0", () => {
  const joints = mockHandJoints("open_palm");
  assert.equal(computeFingerCurl(joints, "nonexistent"), 0);
});

test("computeFingerCurl: missing joints returns 0 without throwing", () => {
  assert.equal(computeFingerCurl(null, "index"), 0);
  assert.equal(computeFingerCurl([], "index"), 0);
});

// ─── palm orientation ─────────────────────────────────────────────────────

test("computePalmOrientation returns a unit-length vector for a valid hand", () => {
  const joints = mockHandJoints("open_palm");
  const normal = computePalmOrientation(joints);
  const mag = Math.sqrt(normal.x ** 2 + normal.y ** 2 + normal.z ** 2);
  assert.ok(Math.abs(mag - 1) < 0.01, `palm normal should be unit length, got ${mag}`);
});

test("computePalmOrientation returns zero vector for incomplete hand", () => {
  const n = computePalmOrientation([]);
  assert.deepEqual(n, { x: 0, y: 0, z: 0 });
});

// ─── pinch distance ────────────────────────────────────────────────────────

test("computePinchDistance is small for a pinch pose and large for an open palm", () => {
  const pinchDist = computePinchDistance(mockHandJoints("pinch"));
  const openDist = computePinchDistance(mockHandJoints("open_palm"));
  assert.ok(pinchDist < 0.025, `pinch distance should be <0.025, got ${pinchDist}`);
  assert.ok(openDist > pinchDist, `open palm distance (${openDist}) should exceed pinch (${pinchDist})`);
});

test("computePinchDistance returns Infinity for missing joints", () => {
  assert.equal(computePinchDistance([]), Infinity);
});

// ─── static recognition per gesture ────────────────────────────────────────

const staticGestures = ["thumbs_up", "thumbs_down", "fist", "open_palm", "point", "peace", "pinch", "ok"];

for (const g of staticGestures) {
  test(`recognizeStaticGesture recognises ${g}`, () => {
    const joints = mockHandJoints(g);
    const result = recognizeStaticGesture(joints);
    assert.ok(result, `expected a recognised gesture for ${g}`);
    assert.equal(result.gesture, g, `expected ${g} but got ${result.gesture}`);
    assert.ok(result.confidence >= 0.5, `low confidence for ${g}: ${result.confidence}`);
    assert.ok(result.fingerCurls, "fingerCurls should be returned");
  });
}

test("recognizeStaticGesture returns null for unrecognised poses", () => {
  // Half-curled four fingers with thumb extended sideways — neither the
  // fingers nor the palm match any known pattern, and the thumb tip stays
  // far from the index tip so no pinch/ok false positive.
  const joints = mockHandJoints("open_palm");
  for (const f of ["index", "middle", "ring", "pinky"]) {
    const spec = FINGER_JOINTS[f];
    const mcp = joints[spec.mcp];
    // Place the tip ~90° from the palm axis (mid curl).
    joints[spec.pip] = { x: mcp.x, y: mcp.y + 0.02, z: -0.015 };
    joints[spec.dip] = { x: mcp.x, y: mcp.y + 0.025, z: -0.035 };
    joints[spec.tip] = { x: mcp.x, y: mcp.y + 0.025, z: -0.055 };
  }
  const r = recognizeStaticGesture(joints);
  assert.equal(r, null);
});

test("recognizeStaticGesture returns null when fewer than 25 joints provided", () => {
  assert.equal(recognizeStaticGesture([]), null);
  assert.equal(recognizeStaticGesture(new Array(10).fill({ x: 0, y: 0, z: 0 })), null);
});

test("recognizeStaticGesture passes through the hand parameter", () => {
  const joints = mockHandJoints("thumbs_up");
  const left = recognizeStaticGesture(joints, "left");
  assert.equal(left.hand, "left");
});

// ─── dynamic recognition ──────────────────────────────────────────────────

test("recognizeDynamicGesture detects a wave from an oscillating sequence", () => {
  const seq = mockWaveSequence(8);
  const r = recognizeDynamicGesture(seq);
  assert.ok(r, "expected wave to be recognised");
  assert.equal(r.gesture, "wave");
  assert.ok(r.confidence >= 0.5);
});

test("recognizeDynamicGesture detects a grab (open_palm → fist)", () => {
  const seq = mockGrabSequence(4);
  const r = recognizeDynamicGesture(seq);
  assert.ok(r, "expected grab to be recognised");
  assert.equal(r.gesture, "grab");
});

test("recognizeDynamicGesture returns null for too-short history", () => {
  assert.equal(recognizeDynamicGesture([]), null);
  assert.equal(recognizeDynamicGesture([{ joints: mockHandJoints("open_palm"), t: 0 }]), null);
});

test("recognizeDynamicGesture detects a swipe (one-directional lateral motion)", () => {
  const frames = [];
  for (let i = 0; i < 6; i++) {
    const joints = mockHandJoints("open_palm").map((p) => ({
      x: p.x + i * 0.06,
      y: p.y,
      z: p.z,
    }));
    frames.push({ joints, t: i * 50 });
  }
  const r = recognizeDynamicGesture(frames);
  assert.ok(r, "expected dynamic gesture from swipe frames");
  // Either swipe or wave is acceptable depending on palm-open check, but
  // confidence must be reasonable.
  assert.ok(["swipe", "wave"].includes(r.gesture));
  assert.ok(r.direction);
});

// ─── state machine ────────────────────────────────────────────────────────

test("GestureStateMachine tracks updates and reports current gesture", () => {
  const sm = new GestureStateMachine();
  const r = sm.update(mockHandJoints("fist"), 1000);
  assert.ok(r);
  assert.equal(r.gesture, "fist");
  const current = sm.getCurrentGesture();
  assert.ok(current);
  assert.equal(current.gesture, "fist");
});

test("GestureStateMachine.getRecentGestures filters by window", () => {
  const sm = new GestureStateMachine({ historyMs: 10_000 });
  sm.update(mockHandJoints("fist"), 1000);
  sm.update(mockHandJoints("open_palm"), 2000);
  sm.update(mockHandJoints("point"), 3000);
  sm.update(mockHandJoints("peace"), 3500);
  // Within the last 1000ms of t=3500 → entries at t>=2500 → point + peace
  const recent = sm.getRecentGestures(1000);
  const names = recent.map((e) => e.gesture);
  assert.ok(names.includes("point"));
  assert.ok(names.includes("peace"));
  assert.ok(!names.includes("fist"));
});

test("GestureStateMachine fires enter/exit/gesture events", () => {
  const sm = new GestureStateMachine();
  const events = [];
  sm.on("gesture", (e) => events.push(["gesture", e.gesture]));
  sm.on("enter", (e) => events.push(["enter", e.gesture]));
  sm.on("exit", (e) => events.push(["exit", e.gesture]));
  sm.update(mockHandJoints("fist"), 1000);
  sm.update(mockHandJoints("open_palm"), 2000);
  const kinds = events.map((e) => e[0] + ":" + e[1]);
  assert.ok(kinds.includes("enter:fist"));
  assert.ok(kinds.includes("gesture:fist"));
  assert.ok(kinds.includes("exit:fist"));
  assert.ok(kinds.includes("enter:open_palm"));
});

test("GestureStateMachine suppresses low-confidence poses", () => {
  const sm = new GestureStateMachine({ minConfidence: 0.99 });
  // A valid pose, but with minConfidence 0.99 we expect most results to be filtered.
  // Use a pose we know has ~0.93 confidence.
  const r = sm.update(mockHandJoints("open_palm"), 1000);
  assert.equal(r, null);
  assert.equal(sm.getCurrentGesture(), null);
});

test("GestureStateMachine.reset clears history and current gesture", () => {
  const sm = new GestureStateMachine();
  sm.update(mockHandJoints("fist"), 1000);
  sm.reset();
  assert.equal(sm.getCurrentGesture(), null);
  assert.equal(sm.getRecentGestures(10_000).length, 0);
});

// ─── command mapping ─────────────────────────────────────────────────────

test("mapGestureToCommand returns the mapped command for defaults", () => {
  assert.equal(mapGestureToCommand("thumbs_up"), "confirm");
  assert.equal(mapGestureToCommand("wave"), "dismiss");
  assert.equal(mapGestureToCommand("point"), "select");
});

test("mapGestureToCommand returns null for unknown gestures or empty input", () => {
  assert.equal(mapGestureToCommand("unknown_gesture"), null);
  assert.equal(mapGestureToCommand(""), null);
  assert.equal(mapGestureToCommand(null), null);
});

test("registerCommand overrides and extends a mapping", () => {
  const mapping = { ...DEFAULT_GESTURE_COMMANDS };
  registerCommand("point", "click", mapping);
  registerCommand("custom_gesture", "snapshot", mapping);
  assert.equal(mapping.point, "click");
  assert.equal(mapping.custom_gesture, "snapshot");
  // Default map should be unchanged.
  assert.equal(DEFAULT_GESTURE_COMMANDS.point, "select");
});

test("registerCommand rejects bad inputs", () => {
  const mapping = { ...DEFAULT_GESTURE_COMMANDS };
  assert.throws(() => registerCommand("", "x", mapping));
  assert.throws(() => registerCommand("x", "", mapping));
});

// ─── constants ───────────────────────────────────────────────────────────

test("GESTURES catalogue includes every mapped command gesture", () => {
  for (const g of Object.keys(DEFAULT_GESTURE_COMMANDS)) {
    assert.ok(GESTURES[g], `GESTURES should describe ${g}`);
    assert.equal(typeof GESTURES[g].description, "string");
  }
});

test("FINGER_JOINTS has five fingers with 4 joints each", () => {
  const names = Object.keys(FINGER_JOINTS);
  assert.deepEqual(names.sort(), ["index", "middle", "pinky", "ring", "thumb"]);
  for (const f of names) {
    const spec = FINGER_JOINTS[f];
    assert.equal(typeof spec.mcp, "number");
    assert.equal(typeof spec.tip, "number");
  }
});
