/**
 * Phase 49.4: Gesture recognition for WebXR hand tracking.
 *
 * Recognises static (thumbs up, fist, pinch, …) and dynamic (wave, grab, swipe)
 * hand gestures from `XRHand`-style joint position arrays, exposes a
 * `GestureStateMachine` for event-driven clients, and maps recognised gestures
 * to logical commands (customisable per caller / user).
 *
 * The module is deliberately free of browser globals so it can be unit tested
 * and reused on the server when clients POST joint data for recognition.
 *
 * Joint positions follow the WebXR 25-joint layout:
 *   0  wrist
 *   1  thumb-metacarpal
 *   2  thumb-phalanx-proximal
 *   3  thumb-phalanx-distal
 *   4  thumb-tip
 *   5  index-metacarpal
 *   6  index-phalanx-proximal
 *   7  index-phalanx-intermediate
 *   8  index-phalanx-distal
 *   9  index-tip
 *   10 middle-metacarpal
 *   11 middle-phalanx-proximal
 *   12 middle-phalanx-intermediate
 *   13 middle-phalanx-distal
 *   14 middle-tip
 *   15 ring-metacarpal
 *   16 ring-phalanx-proximal
 *   17 ring-phalanx-intermediate
 *   18 ring-phalanx-distal
 *   19 ring-tip
 *   20 pinky-metacarpal
 *   21 pinky-phalanx-proximal
 *   22 pinky-phalanx-intermediate
 *   23 pinky-phalanx-distal
 *   24 pinky-tip
 *
 * @module gesture-recognizer
 */

export const GESTURES = {
  thumbs_up: { description: "Thumb extended, other fingers curled" },
  thumbs_down: { description: "Thumb down, other fingers curled" },
  fist: { description: "All fingers curled" },
  open_palm: { description: "All fingers extended" },
  point: { description: "Index extended, others curled" },
  peace: { description: "Index and middle extended, others curled" },
  pinch: { description: "Thumb and index tips close together" },
  ok: { description: "Thumb and index form circle" },
  wave: { description: "Lateral motion of open palm" },
  grab: { description: "Rapid transition from open to fist" },
};

export const FINGER_JOINTS = {
  thumb: { mcp: 1, pip: 2, dip: 3, tip: 4 },
  index: { mcp: 5, pip: 6, dip: 8, tip: 9 },
  middle: { mcp: 10, pip: 11, dip: 13, tip: 14 },
  ring: { mcp: 15, pip: 16, dip: 18, tip: 19 },
  pinky: { mcp: 20, pip: 21, dip: 23, tip: 24 },
};

export const WRIST_JOINT = 0;

const PINCH_THRESHOLD = 0.025; // metres
const OK_THRESHOLD = 0.05;
const CURL_EXTENDED = 0.35;
const CURL_CURLED = 0.6;
const MIN_CONFIDENCE = 0.5;

// ─── math helpers ───────────────────────────────────────────────────────────

function asPoint(p) {
  if (!p) return null;
  const x = Number(p.x ?? p[0]);
  const y = Number(p.y ?? p[1]);
  const z = Number(p.z ?? p[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(a, s) {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function length(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function normalize(v) {
  const L = length(v);
  if (L < 1e-9) return { x: 0, y: 0, z: 0 };
  return { x: v.x / L, y: v.y / L, z: v.z / L };
}

function distance(a, b) {
  return length(sub(a, b));
}

function angleBetween(a, b) {
  const la = length(a);
  const lb = length(b);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
  return Math.acos(cos);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function getJoint(jointPositions, idx) {
  if (!jointPositions) return null;
  const raw = jointPositions[idx];
  return asPoint(raw);
}

// ─── finger curl & palm orientation ─────────────────────────────────────────

/**
 * Compute a curl ratio (0 = fully extended, 1 = fully curled) for a finger.
 * The curl is derived from the aggregate bend angle across the MCP → PIP → DIP → tip chain.
 * @param {Array} jointPositions - 25-joint XRHand-style array
 * @param {"thumb"|"index"|"middle"|"ring"|"pinky"} finger
 * @returns {number}
 */
export function computeFingerCurl(jointPositions, finger) {
  const spec = FINGER_JOINTS[finger];
  if (!spec) return 0;
  const wrist = getJoint(jointPositions, WRIST_JOINT);
  const mcp = getJoint(jointPositions, spec.mcp);
  const pip = getJoint(jointPositions, spec.pip);
  const dip = getJoint(jointPositions, spec.dip);
  const tip = getJoint(jointPositions, spec.tip);
  if (!wrist || !mcp || !pip || !dip || !tip) return 0;

  // Metric 1 — cumulative bend across MCP→PIP, PIP→DIP, DIP→tip segments.
  // A straight finger has parallel segments (angle ≈ 0) and totalBend ≈ 0.
  // A fully curled finger has segments doubling back (totalBend ≈ π).
  const v1 = sub(pip, mcp);
  const v2 = sub(dip, pip);
  const v3 = sub(tip, dip);
  const a1 = angleBetween(v1, v2);
  const a2 = angleBetween(v2, v3);
  const totalBend = a1 + a2;
  const bendCurl = clamp01(totalBend / (Math.PI * 0.9));

  // Metric 2 — angle between the palm axis (wrist→MCP) and the finger axis
  // (MCP→tip). When the finger is extended these two point in roughly the
  // same direction (angle ≈ 0). When curled the finger folds back toward the
  // wrist (angle → π). This metric is independent of finger length, so it
  // works equally well for thumb, index, and pinky.
  const palmAxis = sub(mcp, wrist);
  const fingerAxis = sub(tip, mcp);
  const foldAngle = angleBetween(palmAxis, fingerAxis);
  const foldCurl = clamp01(foldAngle / (Math.PI * 0.9));

  return clamp01(bendCurl * 0.55 + foldCurl * 0.45);
}

/**
 * Compute palm normal (unit vector) from wrist, index-MCP, pinky-MCP.
 * Returns { x:0,y:0,z:0 } when the input is missing joints.
 * @param {Array} jointPositions
 * @returns {{x:number,y:number,z:number}}
 */
export function computePalmOrientation(jointPositions) {
  const wrist = getJoint(jointPositions, WRIST_JOINT);
  const indexMcp = getJoint(jointPositions, FINGER_JOINTS.index.mcp);
  const pinkyMcp = getJoint(jointPositions, FINGER_JOINTS.pinky.mcp);
  if (!wrist || !indexMcp || !pinkyMcp) return { x: 0, y: 0, z: 0 };
  const v1 = sub(indexMcp, wrist);
  const v2 = sub(pinkyMcp, wrist);
  return normalize(cross(v1, v2));
}

/**
 * Distance between thumb tip and index tip in metres.
 * @param {Array} jointPositions
 * @returns {number}
 */
export function computePinchDistance(jointPositions) {
  const thumbTip = getJoint(jointPositions, FINGER_JOINTS.thumb.tip);
  const indexTip = getJoint(jointPositions, FINGER_JOINTS.index.tip);
  if (!thumbTip || !indexTip) return Infinity;
  return distance(thumbTip, indexTip);
}

function allCurls(jointPositions) {
  return {
    thumb: computeFingerCurl(jointPositions, "thumb"),
    index: computeFingerCurl(jointPositions, "index"),
    middle: computeFingerCurl(jointPositions, "middle"),
    ring: computeFingerCurl(jointPositions, "ring"),
    pinky: computeFingerCurl(jointPositions, "pinky"),
  };
}

function isExtended(curl) {
  return curl <= CURL_EXTENDED;
}

function isCurled(curl) {
  return curl >= CURL_CURLED;
}

function thumbDirection(jointPositions) {
  const tip = getJoint(jointPositions, FINGER_JOINTS.thumb.tip);
  const mcp = getJoint(jointPositions, FINGER_JOINTS.thumb.mcp);
  if (!tip || !mcp) return null;
  return normalize(sub(tip, mcp));
}

// ─── static recognition ─────────────────────────────────────────────────────

/**
 * Recognise a static hand pose.
 * @param {Array} jointPositions
 * @param {"right"|"left"} [hand="right"]
 * @returns {{gesture:string, confidence:number, fingerCurls:object}|null}
 */
export function recognizeStaticGesture(jointPositions, hand = "right") {
  if (!Array.isArray(jointPositions) || jointPositions.length < 25) return null;
  const wrist = getJoint(jointPositions, WRIST_JOINT);
  if (!wrist) return null;

  const curls = allCurls(jointPositions);
  const pinchDist = computePinchDistance(jointPositions);

  const thumbExt = isExtended(curls.thumb);
  const indexExt = isExtended(curls.index);
  const middleExt = isExtended(curls.middle);
  const ringExt = isExtended(curls.ring);
  const pinkyExt = isExtended(curls.pinky);

  const thumbCurled = isCurled(curls.thumb);
  const indexCurled = isCurled(curls.index);
  const middleCurled = isCurled(curls.middle);
  const ringCurled = isCurled(curls.ring);
  const pinkyCurled = isCurled(curls.pinky);

  // pinch: thumb tip & index tip close together (regardless of other fingers)
  if (pinchDist <= PINCH_THRESHOLD) {
    const conf = clamp01(1 - pinchDist / PINCH_THRESHOLD);
    return { gesture: "pinch", confidence: Math.max(0.6, conf), fingerCurls: curls, hand };
  }

  // ok: thumb/index tips close (circle) and middle/ring/pinky extended
  if (pinchDist <= OK_THRESHOLD && middleExt && ringExt && pinkyExt) {
    const conf = clamp01(1 - pinchDist / OK_THRESHOLD) * 0.5 + 0.5;
    return { gesture: "ok", confidence: conf, fingerCurls: curls, hand };
  }

  // open palm
  if (thumbExt && indexExt && middleExt && ringExt && pinkyExt) {
    const avg =
      (curls.thumb + curls.index + curls.middle + curls.ring + curls.pinky) / 5;
    const conf = clamp01(1 - avg / CURL_EXTENDED) * 0.5 + 0.5;
    return { gesture: "open_palm", confidence: conf, fingerCurls: curls, hand };
  }

  // fist
  if (thumbCurled && indexCurled && middleCurled && ringCurled && pinkyCurled) {
    const avg =
      (curls.thumb + curls.index + curls.middle + curls.ring + curls.pinky) / 5;
    const conf = clamp01((avg - CURL_CURLED) / (1 - CURL_CURLED)) * 0.5 + 0.5;
    return { gesture: "fist", confidence: conf, fingerCurls: curls, hand };
  }

  // peace: index + middle extended, ring + pinky curled
  if (indexExt && middleExt && ringCurled && pinkyCurled) {
    const conf =
      clamp01(1 - (curls.index + curls.middle) / (2 * CURL_EXTENDED)) * 0.3 + 0.65;
    return { gesture: "peace", confidence: conf, fingerCurls: curls, hand };
  }

  // point: only index extended
  if (indexExt && middleCurled && ringCurled && pinkyCurled) {
    const conf = clamp01(1 - curls.index / CURL_EXTENDED) * 0.3 + 0.65;
    return { gesture: "point", confidence: conf, fingerCurls: curls, hand };
  }

  // thumbs up/down: thumb extended, other fingers curled, discriminated by
  // the direction of the thumb tip from its MCP joint (relative to world up).
  if (thumbExt && indexCurled && middleCurled && ringCurled && pinkyCurled) {
    const dir = thumbDirection(jointPositions);
    if (dir) {
      const upness = dir.y; // world up is +y
      const conf = clamp01(Math.abs(upness)) * 0.4 + 0.6;
      if (upness > 0.4) {
        return { gesture: "thumbs_up", confidence: conf, fingerCurls: curls, hand };
      }
      if (upness < -0.4) {
        return { gesture: "thumbs_down", confidence: conf, fingerCurls: curls, hand };
      }
    }
  }

  return null;
}

// ─── dynamic recognition ────────────────────────────────────────────────────

function wristPositionAt(sample) {
  if (!sample || !sample.joints) return null;
  return getJoint(sample.joints, WRIST_JOINT);
}

/**
 * Recognise dynamic gestures from a history of joint-position snapshots.
 * @param {Array<{joints:Array, t:number}>} positionHistory
 * @param {number} [dt] - approx frame delta in ms (optional)
 * @returns {{gesture:string, confidence:number, direction?:string}|null}
 */
export function recognizeDynamicGesture(positionHistory, dt) {
  if (!Array.isArray(positionHistory) || positionHistory.length < 3) return null;
  const n = positionHistory.length;
  const first = positionHistory[0];
  const last = positionHistory[n - 1];
  if (!first || !last) return null;

  // grab: transition from open_palm -> fist in the window
  const firstStatic = first.joints ? recognizeStaticGesture(first.joints) : null;
  const lastStatic = last.joints ? recognizeStaticGesture(last.joints) : null;
  if (
    firstStatic &&
    lastStatic &&
    firstStatic.gesture === "open_palm" &&
    lastStatic.gesture === "fist"
  ) {
    const conf = Math.min(firstStatic.confidence, lastStatic.confidence) * 0.6 + 0.4;
    return { gesture: "grab", confidence: clamp01(conf) };
  }

  // wave: lateral oscillation of wrist x-coordinate while hand roughly open
  const wristPositions = positionHistory
    .map(wristPositionAt)
    .filter((p) => p != null);
  if (wristPositions.length < 3) return null;

  let zeroCrossings = 0;
  let totalLateral = 0;
  let prevDir = 0;
  for (let i = 1; i < wristPositions.length; i++) {
    const dx = wristPositions[i].x - wristPositions[i - 1].x;
    totalLateral += Math.abs(dx);
    const curDir = dx > 1e-4 ? 1 : dx < -1e-4 ? -1 : 0;
    if (curDir !== 0 && prevDir !== 0 && curDir !== prevDir) zeroCrossings++;
    if (curDir !== 0) prevDir = curDir;
  }

  const palmOpenAtStart = firstStatic && firstStatic.gesture === "open_palm";
  const palmOpenAtEnd = lastStatic && lastStatic.gesture === "open_palm";

  if (zeroCrossings >= 2 && totalLateral >= 0.15 && (palmOpenAtStart || palmOpenAtEnd)) {
    const conf = clamp01(0.5 + zeroCrossings * 0.1 + totalLateral * 0.5);
    const netDx = last.joints && first.joints
      ? (wristPositions[wristPositions.length - 1].x - wristPositions[0].x)
      : 0;
    return {
      gesture: "wave",
      confidence: conf,
      direction: Math.abs(netDx) < 0.02 ? "lateral" : netDx > 0 ? "right" : "left",
    };
  }

  // swipe: mostly one-directional lateral motion (no oscillation)
  if (zeroCrossings === 0 && totalLateral >= 0.2) {
    const netDx = wristPositions[wristPositions.length - 1].x - wristPositions[0].x;
    return {
      gesture: "swipe",
      confidence: clamp01(0.5 + totalLateral),
      direction: netDx > 0 ? "right" : "left",
    };
  }

  return null;
}

// ─── state machine ─────────────────────────────────────────────────────────

/**
 * Tracks gesture state across frames, fires events on transitions, and
 * records a rolling history of recognised gestures.
 */
export class GestureStateMachine {
  constructor(options = {}) {
    this.options = {
      minConfidence: options.minConfidence ?? MIN_CONFIDENCE,
      historyMs: options.historyMs ?? 5000,
      dynamicWindowMs: options.dynamicWindowMs ?? 1200,
      hand: options.hand || "right",
    };
    /** @type {Array<{gesture:string, confidence:number, t:number}>} */
    this.history = [];
    /** @type {Array<{joints:Array, t:number}>} */
    this.positionHistory = [];
    /** @type {Record<string, Array<Function>>} */
    this.listeners = {};
    this.currentGesture = null;
  }

  /**
   * Subscribe to events. Supported events:
   *   - "gesture": fires on every new recognised gesture
   *   - "enter":   fires when a new gesture becomes current (transition)
   *   - "exit":    fires when the previous gesture ends
   */
  on(event, handler) {
    if (typeof handler !== "function") return this;
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
    return this;
  }

  off(event, handler) {
    if (!this.listeners[event]) return this;
    this.listeners[event] = this.listeners[event].filter((h) => h !== handler);
    return this;
  }

  _emit(event, payload) {
    const handlers = this.listeners[event] || [];
    for (const h of handlers) {
      try {
        h(payload);
      } catch {
        // handler errors never break the state machine
      }
    }
  }

  _trim(now) {
    const cutoff = now - this.options.historyMs;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
    const posCutoff = now - this.options.dynamicWindowMs;
    while (this.positionHistory.length && this.positionHistory[0].t < posCutoff) {
      this.positionHistory.shift();
    }
  }

  /**
   * Feed the state machine a new joint snapshot. Returns the recognised
   * gesture (or null).
   * @param {Array} jointPositions
   * @param {number} [timestamp]
   */
  update(jointPositions, timestamp) {
    const t = typeof timestamp === "number" ? timestamp : Date.now();
    this.positionHistory.push({ joints: jointPositions, t });
    this._trim(t);

    const staticResult = recognizeStaticGesture(jointPositions, this.options.hand);
    const dynamicResult = recognizeDynamicGesture(this.positionHistory);

    let chosen = null;
    if (
      dynamicResult &&
      dynamicResult.confidence >= this.options.minConfidence &&
      (!staticResult || dynamicResult.confidence > staticResult.confidence)
    ) {
      chosen = dynamicResult;
    } else if (staticResult && staticResult.confidence >= this.options.minConfidence) {
      chosen = staticResult;
    }

    if (!chosen) {
      if (this.currentGesture) {
        const prev = this.currentGesture;
        this.currentGesture = null;
        this._emit("exit", { gesture: prev.gesture, t });
      }
      return null;
    }

    const entry = { gesture: chosen.gesture, confidence: chosen.confidence, t };
    this.history.push(entry);
    this._emit("gesture", { ...chosen, t });

    if (!this.currentGesture || this.currentGesture.gesture !== chosen.gesture) {
      if (this.currentGesture) {
        this._emit("exit", { gesture: this.currentGesture.gesture, t });
      }
      this.currentGesture = entry;
      this._emit("enter", { ...chosen, t });
    } else {
      this.currentGesture = entry;
    }

    return chosen;
  }

  getCurrentGesture() {
    return this.currentGesture;
  }

  getRecentGestures(windowMs = 1000) {
    const now = this.history.length ? this.history[this.history.length - 1].t : Date.now();
    const cutoff = now - windowMs;
    return this.history.filter((e) => e.t >= cutoff);
  }

  reset() {
    this.history = [];
    this.positionHistory = [];
    this.currentGesture = null;
  }
}

// ─── command mapping ───────────────────────────────────────────────────────

export const DEFAULT_GESTURE_COMMANDS = {
  thumbs_up: "confirm",
  thumbs_down: "cancel",
  fist: "grab",
  open_palm: "release",
  point: "select",
  peace: "copy",
  pinch: "grab_precise",
  ok: "approve",
  wave: "dismiss",
};

/**
 * Look up the logical command for a gesture.
 * @param {string} gesture
 * @param {Record<string,string>} [mapping]
 * @returns {string|null}
 */
export function mapGestureToCommand(gesture, mapping = DEFAULT_GESTURE_COMMANDS) {
  if (!gesture || !mapping) return null;
  const cmd = mapping[gesture];
  return typeof cmd === "string" ? cmd : null;
}

/**
 * Register or override a command mapping. Returns the updated mapping (the same
 * object that was passed in, mutated) so callers can chain calls.
 * @param {string} gesture
 * @param {string} command
 * @param {Record<string,string>} [mapping]
 */
export function registerCommand(gesture, command, mapping = DEFAULT_GESTURE_COMMANDS) {
  if (typeof gesture !== "string" || !gesture.trim()) {
    throw new Error("gesture must be a non-empty string");
  }
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("command must be a non-empty string");
  }
  mapping[gesture] = command;
  return mapping;
}

// ─── mock joint generator ──────────────────────────────────────────────────

function mockHandBase() {
  // Build a default open-palm hand rooted at the origin with the wrist at
  // (0,0,0). Four fingers extend in +y; the thumb extends to the side (−x)
  // at an angle so it doesn't accidentally touch the index finger.
  // Coordinates are in metres. Palm lies in the x/y plane, normal is +z.
  const joints = new Array(25);
  joints[WRIST_JOINT] = { x: 0, y: 0, z: 0 };
  const fingerXOffsets = { index: -0.03, middle: -0.01, ring: 0.01, pinky: 0.03 };
  const segmentLen = 0.03;
  const baseY = 0.05;
  for (const f of ["index", "middle", "ring", "pinky"]) {
    const x = fingerXOffsets[f];
    const spec = FINGER_JOINTS[f];
    joints[spec.mcp] = { x, y: baseY, z: 0 };
    joints[spec.pip] = { x, y: baseY + segmentLen, z: 0 };
    joints[spec.dip] = { x, y: baseY + 2 * segmentLen, z: 0 };
    joints[spec.tip] = { x, y: baseY + 3 * segmentLen, z: 0 };
  }
  // Thumb — extends diagonally in the −x/+y direction
  const thumbSpec = FINGER_JOINTS.thumb;
  joints[thumbSpec.mcp] = { x: -0.04, y: 0.03, z: 0 };
  joints[thumbSpec.pip] = { x: -0.06, y: 0.05, z: 0 };
  joints[thumbSpec.dip] = { x: -0.08, y: 0.07, z: 0 };
  joints[thumbSpec.tip] = { x: -0.1, y: 0.09, z: 0 };
  return joints;
}

function curlFinger(joints, finger, amount) {
  // `amount` 0..1 — fold the finger toward the palm about the MCP joint.
  // Build the curled shape in a local 2-D frame (u = finger axis, v = palm
  // normal) and rotate each successive segment by `angle` about the MCP.
  const spec = FINGER_JOINTS[finger];
  const mcp = joints[spec.mcp];
  const angle = amount * (Math.PI * 0.55); // each segment rotates up to ~100°
  const segLen = 0.03;
  // Finger axis direction (u) — pip − mcp when available, else +y
  const pipDef = joints[spec.pip] || { x: mcp.x, y: mcp.y + segLen, z: mcp.z };
  const uRaw = sub(pipDef, mcp);
  const u = length(uRaw) > 1e-6 ? normalize(uRaw) : { x: 0, y: 1, z: 0 };
  // Palm-normal (v) — points toward −z (palm faces +z by default)
  const v = { x: 0, y: 0, z: -1 };

  const segs = [spec.pip, spec.dip, spec.tip];
  let prev = { ...mcp };
  let currentAngle = 0;
  for (let i = 0; i < segs.length; i++) {
    currentAngle += angle;
    const sin = Math.sin(currentAngle);
    const cos = Math.cos(currentAngle);
    const next = {
      x: prev.x + (u.x * cos + v.x * sin) * segLen,
      y: prev.y + (u.y * cos + v.y * sin) * segLen,
      z: prev.z + (u.z * cos + v.z * sin) * segLen,
    };
    joints[segs[i]] = next;
    prev = next;
  }
}

function setThumbDirection(joints, dirY) {
  // Thumb extended along dirY (±1) relative to wrist
  const spec = FINGER_JOINTS.thumb;
  const mcp = { x: -0.04, y: 0.02, z: 0 };
  joints[spec.mcp] = mcp;
  const step = 0.03;
  joints[spec.pip] = { x: mcp.x, y: mcp.y + step * dirY, z: 0 };
  joints[spec.dip] = { x: mcp.x, y: mcp.y + 2 * step * dirY, z: 0 };
  joints[spec.tip] = { x: mcp.x, y: mcp.y + 3 * step * dirY, z: 0 };
}

/**
 * Produce a deterministic 25-joint hand position array for a named gesture.
 * Used by tests and for UI preview/demo purposes.
 * @param {string} gesture
 * @returns {Array<{x:number,y:number,z:number}>}
 */
export function mockHandJoints(gesture) {
  const joints = mockHandBase();
  switch (gesture) {
    case "open_palm":
      // already extended
      break;
    case "fist":
      for (const f of ["thumb", "index", "middle", "ring", "pinky"]) curlFinger(joints, f, 1);
      // Flatten thumb tip near the palm
      {
        const spec = FINGER_JOINTS.thumb;
        joints[spec.tip] = { x: -0.01, y: 0.03, z: -0.02 };
        joints[spec.dip] = { x: -0.02, y: 0.03, z: -0.01 };
      }
      break;
    case "point":
      curlFinger(joints, "thumb", 0.8);
      curlFinger(joints, "middle", 1);
      curlFinger(joints, "ring", 1);
      curlFinger(joints, "pinky", 1);
      break;
    case "peace":
      curlFinger(joints, "thumb", 0.8);
      curlFinger(joints, "ring", 1);
      curlFinger(joints, "pinky", 1);
      break;
    case "thumbs_up":
      curlFinger(joints, "index", 1);
      curlFinger(joints, "middle", 1);
      curlFinger(joints, "ring", 1);
      curlFinger(joints, "pinky", 1);
      setThumbDirection(joints, 1);
      break;
    case "thumbs_down":
      curlFinger(joints, "index", 1);
      curlFinger(joints, "middle", 1);
      curlFinger(joints, "ring", 1);
      curlFinger(joints, "pinky", 1);
      setThumbDirection(joints, -1);
      break;
    case "pinch": {
      // Bring thumb tip and index tip together
      const meet = { x: 0, y: 0.12, z: 0 };
      joints[FINGER_JOINTS.thumb.tip] = { ...meet };
      joints[FINGER_JOINTS.index.tip] = { x: meet.x + 0.005, y: meet.y, z: 0 };
      curlFinger(joints, "middle", 0.9);
      curlFinger(joints, "ring", 0.9);
      curlFinger(joints, "pinky", 0.9);
      // Pull thumb MCP in so it can reach the meet point naturally.
      joints[FINGER_JOINTS.thumb.mcp] = { x: -0.01, y: 0.06, z: 0 };
      joints[FINGER_JOINTS.thumb.pip] = { x: -0.005, y: 0.08, z: 0 };
      joints[FINGER_JOINTS.thumb.dip] = { x: 0, y: 0.1, z: 0 };
      break;
    }
    case "ok": {
      // Thumb/index form a circle (~OK_THRESHOLD distance), others extended.
      const meet = { x: 0, y: 0.12, z: 0 };
      joints[FINGER_JOINTS.thumb.tip] = { ...meet };
      joints[FINGER_JOINTS.index.tip] = { x: meet.x + 0.035, y: meet.y, z: 0 };
      // middle/ring/pinky remain extended (default)
      joints[FINGER_JOINTS.thumb.mcp] = { x: -0.01, y: 0.06, z: 0 };
      joints[FINGER_JOINTS.thumb.pip] = { x: -0.005, y: 0.08, z: 0 };
      joints[FINGER_JOINTS.thumb.dip] = { x: 0, y: 0.1, z: 0 };
      break;
    }
    default:
      break;
  }
  return joints;
}

/**
 * Helper: produce a wave sequence suitable for `recognizeDynamicGesture`.
 * Returns an array of { joints, t } samples.
 * @param {number} [frames=6]
 */
export function mockWaveSequence(frames = 6) {
  const out = [];
  for (let i = 0; i < frames; i++) {
    const phase = (i / (frames - 1)) * Math.PI * 2;
    const joints = mockHandJoints("open_palm").map((p) => ({
      x: p.x + Math.sin(phase) * 0.08,
      y: p.y,
      z: p.z,
    }));
    out.push({ joints, t: i * 50 });
  }
  return out;
}

/**
 * Helper: produce a grab sequence (open → fist).
 * @param {number} [frames=4]
 */
export function mockGrabSequence(frames = 4) {
  const out = [];
  out.push({ joints: mockHandJoints("open_palm"), t: 0 });
  for (let i = 1; i < frames - 1; i++) {
    out.push({ joints: mockHandJoints("open_palm"), t: i * 50 });
  }
  out.push({ joints: mockHandJoints("fist"), t: (frames - 1) * 50 });
  return out;
}

export default {
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
};
