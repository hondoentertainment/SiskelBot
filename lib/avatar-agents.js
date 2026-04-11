/**
 * Phase 49.3: Avatar agents — 3D avatar representations of agents for immersive chat.
 *
 * Configures and persists avatar metadata (model reference, pose, voice settings,
 * emotion state) per agent/workspace/user. Exposes helpers the XR client uses to
 * drive lip-sync, emotion, and idle animation. Animation state is tracked per
 * active agent session so multiple avatars can coexist in a scene.
 *
 * Storage layout:
 *   data/avatars/configs.json   { _version, items: [AvatarConfig] }
 *   data/avatars/states.json    { _version, states: { [avatarId]: state } }
 *   data/avatars/sessions.json  { _version, sessions: { [sessionId]: [avatarId] } }
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_CONFIGS = 10_000;

export const DEFAULT_AVATAR_MODELS = {
  cube: { type: "primitive", shape: "cube", color: "#4a90e2" },
  sphere: { type: "primitive", shape: "sphere", color: "#7e57c2" },
  capsule: { type: "primitive", shape: "capsule", color: "#26a69a" },
  helper: { type: "primitive", shape: "humanoid", color: "#ef5350" },
};

const VALID_MOODS = new Set(["neutral", "happy", "sad", "surprised", "focused", "angry"]);
const VALID_ANIMATIONS = new Set(["idle", "talking", "listening", "thinking", "gesturing", "waving"]);

const DEFAULT_VISEMES = [
  "sil", "aa", "ih", "ou", "ee", "th", "ff", "mm", "ss", "nn", "rr", "kk",
];
const CLASSIC_VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "ih", "oh", "ou"];

function configsPath() {
  return join(getDataDir(), "avatars", "configs.json");
}

function statesPath() {
  return join(getDataDir(), "avatars", "states.json");
}

function sessionsPath() {
  return join(getDataDir(), "avatars", "sessions.json");
}

async function loadConfigs() {
  const data = await readJsonPath(configsPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveConfigs(items) {
  const trimmed = items.length > MAX_CONFIGS ? items.slice(-MAX_CONFIGS) : items;
  await writeJsonPath(configsPath(), { _version: 1, items: trimmed });
}

async function loadStates() {
  const data = await readJsonPath(statesPath(), { _version: 1, states: {} });
  return data.states && typeof data.states === "object" ? data.states : {};
}

async function saveStates(states) {
  await writeJsonPath(statesPath(), { _version: 1, states });
}

async function loadSessions() {
  const data = await readJsonPath(sessionsPath(), { _version: 1, sessions: {} });
  return data.sessions && typeof data.sessions === "object" ? data.sessions : {};
}

async function saveSessions(sessions) {
  await writeJsonPath(sessionsPath(), { _version: 1, sessions });
}

function normalizeVec3(v, fallback = [0, 0, 0]) {
  if (!v) return [...fallback];
  if (Array.isArray(v)) {
    return [
      Number.isFinite(v[0]) ? Number(v[0]) : fallback[0],
      Number.isFinite(v[1]) ? Number(v[1]) : fallback[1],
      Number.isFinite(v[2]) ? Number(v[2]) : fallback[2],
    ];
  }
  if (typeof v === "object") {
    return [
      Number.isFinite(v.x) ? Number(v.x) : fallback[0],
      Number.isFinite(v.y) ? Number(v.y) : fallback[1],
      Number.isFinite(v.z) ? Number(v.z) : fallback[2],
    ];
  }
  return [...fallback];
}

function normalizeModelRef(ref) {
  if (!ref) return { ...DEFAULT_AVATAR_MODELS.capsule };
  if (typeof ref === "string") {
    if (DEFAULT_AVATAR_MODELS[ref]) return { ...DEFAULT_AVATAR_MODELS[ref] };
    return { type: "glb", url: ref };
  }
  if (typeof ref === "object") {
    return { ...ref };
  }
  return { ...DEFAULT_AVATAR_MODELS.capsule };
}

function normalizeVoice(voice) {
  if (!voice || typeof voice !== "object") {
    return { provider: "default", voiceId: "default", pitch: 1.0, rate: 1.0, volume: 1.0 };
  }
  return {
    provider: String(voice.provider || "default"),
    voiceId: String(voice.voiceId || "default"),
    pitch: Number.isFinite(voice.pitch) ? Number(voice.pitch) : 1.0,
    rate: Number.isFinite(voice.rate) ? Number(voice.rate) : 1.0,
    volume: Number.isFinite(voice.volume) ? Number(voice.volume) : 1.0,
  };
}

function publicConfig(c) {
  if (!c) return null;
  return {
    avatarId: c.avatarId,
    agentId: c.agentId || null,
    workspaceId: c.workspaceId || null,
    userId: c.userId || null,
    modelRef: c.modelRef,
    voice: c.voice,
    position: c.position,
    rotation: c.rotation,
    scale: c.scale,
    metadata: c.metadata || {},
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * Create a new avatar configuration.
 * @param {object} input
 * @param {string} [input.agentId]
 * @param {string} [input.workspaceId]
 * @param {string} [input.userId]
 * @param {string|object} [input.modelRef]
 * @param {object} [input.voice]
 * @param {number[]|object} [input.position]
 * @param {number[]|object} [input.rotation]
 * @param {number[]|object|number} [input.scale]
 * @param {object} [input.metadata]
 */
export async function createAvatarConfig({
  agentId,
  workspaceId,
  userId,
  modelRef,
  voice,
  position,
  rotation,
  scale,
  metadata,
} = {}) {
  const avatarId = `avatar_${randomUUID()}`;
  const now = new Date().toISOString();
  const scaleVec =
    typeof scale === "number" && Number.isFinite(scale)
      ? [scale, scale, scale]
      : normalizeVec3(scale, [1, 1, 1]);
  const record = {
    avatarId,
    agentId: agentId ? String(agentId) : null,
    workspaceId: workspaceId ? String(workspaceId) : null,
    userId: userId ? String(userId) : null,
    modelRef: normalizeModelRef(modelRef),
    voice: normalizeVoice(voice),
    position: normalizeVec3(position, [0, 0, 0]),
    rotation: normalizeVec3(rotation, [0, 0, 0]),
    scale: scaleVec,
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
    createdAt: now,
    updatedAt: now,
  };

  await withPathLock(configsPath(), async () => {
    const items = await loadConfigs();
    items.push(record);
    await saveConfigs(items);
  });

  return publicConfig(record);
}

export async function getAvatarConfig(avatarId) {
  if (!avatarId) return null;
  const items = await loadConfigs();
  return publicConfig(items.find((i) => i.avatarId === avatarId) || null);
}

export async function listAvatars(filter = {}) {
  const items = await loadConfigs();
  let filtered = items;
  if (filter && typeof filter === "object") {
    if (filter.agentId) {
      filtered = filtered.filter((i) => i.agentId === filter.agentId);
    }
    if (filter.workspaceId) {
      filtered = filtered.filter((i) => i.workspaceId === filter.workspaceId);
    }
    if (filter.userId) {
      filtered = filtered.filter((i) => i.userId === filter.userId);
    }
  }
  return filtered.map(publicConfig);
}

export async function updateAvatarConfig(avatarId, updates = {}) {
  if (!avatarId) throw new Error("avatarId is required");
  if (!updates || typeof updates !== "object") throw new Error("updates must be an object");

  let updated = null;
  await withPathLock(configsPath(), async () => {
    const items = await loadConfigs();
    const idx = items.findIndex((i) => i.avatarId === avatarId);
    if (idx < 0) return;
    const current = items[idx];
    const next = { ...current };
    if (updates.agentId !== undefined) next.agentId = updates.agentId ? String(updates.agentId) : null;
    if (updates.workspaceId !== undefined) next.workspaceId = updates.workspaceId ? String(updates.workspaceId) : null;
    if (updates.userId !== undefined) next.userId = updates.userId ? String(updates.userId) : null;
    if (updates.modelRef !== undefined) next.modelRef = normalizeModelRef(updates.modelRef);
    if (updates.voice !== undefined) next.voice = { ...current.voice, ...normalizeVoice(updates.voice) };
    if (updates.position !== undefined) next.position = normalizeVec3(updates.position, current.position);
    if (updates.rotation !== undefined) next.rotation = normalizeVec3(updates.rotation, current.rotation);
    if (updates.scale !== undefined) {
      next.scale =
        typeof updates.scale === "number" && Number.isFinite(updates.scale)
          ? [updates.scale, updates.scale, updates.scale]
          : normalizeVec3(updates.scale, current.scale);
    }
    if (updates.metadata !== undefined && updates.metadata && typeof updates.metadata === "object") {
      next.metadata = { ...current.metadata, ...updates.metadata };
    }
    next.updatedAt = new Date().toISOString();
    items[idx] = next;
    updated = next;
    await saveConfigs(items);
  });

  return publicConfig(updated);
}

export async function deleteAvatarConfig(avatarId) {
  if (!avatarId) throw new Error("avatarId is required");
  let removed = false;
  await withPathLock(configsPath(), async () => {
    const items = await loadConfigs();
    const next = items.filter((i) => i.avatarId !== avatarId);
    if (next.length !== items.length) {
      removed = true;
      await saveConfigs(next);
    }
  });
  // Cascade: drop state and remove from any session tracking.
  if (removed) {
    await withPathLock(statesPath(), async () => {
      const states = await loadStates();
      if (states[avatarId]) {
        delete states[avatarId];
        await saveStates(states);
      }
    });
    await withPathLock(sessionsPath(), async () => {
      const sessions = await loadSessions();
      let changed = false;
      for (const sid of Object.keys(sessions)) {
        const list = sessions[sid];
        if (Array.isArray(list) && list.includes(avatarId)) {
          sessions[sid] = list.filter((a) => a !== avatarId);
          changed = true;
        }
      }
      if (changed) await saveSessions(sessions);
    });
  }
  return { ok: removed };
}

/* ---------------- Animation state ---------------- */

function normalizeState(state, base = {}) {
  const s = state && typeof state === "object" ? state : {};
  const mood = typeof s.mood === "string" && VALID_MOODS.has(s.mood) ? s.mood : base.mood || "neutral";
  const animation =
    typeof s.animation === "string" && VALID_ANIMATIONS.has(s.animation)
      ? s.animation
      : base.animation || "idle";
  const lookAt = s.lookAt !== undefined ? normalizeVec3(s.lookAt, base.lookAt || [0, 0, 0]) : base.lookAt || [0, 0, 0];
  const speaking = typeof s.speaking === "boolean" ? s.speaking : !!base.speaking;
  const gesture = typeof s.gesture === "string" ? s.gesture : base.gesture || null;
  return { mood, animation, lookAt, speaking, gesture };
}

export async function setAvatarState(avatarId, state) {
  if (!avatarId) throw new Error("avatarId is required");
  let merged = null;
  await withPathLock(statesPath(), async () => {
    const states = await loadStates();
    const current = states[avatarId] || {};
    merged = {
      ...normalizeState(state, current),
      updatedAt: new Date().toISOString(),
    };
    states[avatarId] = merged;
    await saveStates(states);
  });
  return merged;
}

export async function getAvatarState(avatarId) {
  if (!avatarId) return null;
  const states = await loadStates();
  return states[avatarId] || null;
}

/* ---------------- Lip-sync ---------------- */

/**
 * Approximate visemes from audio metadata (envelope/duration) so the XR client
 * can drive mouth-shape blendshapes without needing a real phoneme aligner.
 *
 * @param {{ durationMs?: number, envelope?: number[], text?: string }} audioMetadata
 * @param {"default"|"classic"|string[]} [visemeSet]
 * @returns {Array<{ time: number, viseme: string, weight: number }>}
 */
export function computeLipSync(audioMetadata, visemeSet = "default") {
  const meta = audioMetadata && typeof audioMetadata === "object" ? audioMetadata : {};
  let set = DEFAULT_VISEMES;
  if (Array.isArray(visemeSet) && visemeSet.length) set = visemeSet;
  else if (visemeSet === "classic") set = CLASSIC_VISEMES;
  else set = DEFAULT_VISEMES;

  const envelope = Array.isArray(meta.envelope) ? meta.envelope.filter((v) => Number.isFinite(v)) : null;
  const durationMs = Number.isFinite(meta.durationMs) && meta.durationMs > 0
    ? meta.durationMs
    : envelope && envelope.length
      ? envelope.length * 50
      : typeof meta.text === "string" && meta.text.length
        ? Math.max(400, meta.text.length * 60)
        : 1000;

  const textLen = typeof meta.text === "string" ? meta.text.length : 0;
  const derivedCount = envelope
    ? envelope.length
    : Math.max(4, Math.min(120, Math.round(durationMs / 80) + Math.ceil(textLen / 4)));

  const result = [];
  for (let i = 0; i < derivedCount; i++) {
    const t = (durationMs * i) / Math.max(1, derivedCount);
    // Rotate through the viseme set; bias on envelope energy when provided.
    const envWeight = envelope ? Math.max(0, Math.min(1, envelope[i] ?? 0)) : 0.5 + 0.5 * Math.sin(i * 1.2);
    const idx = (i + Math.floor(envWeight * (set.length - 1))) % set.length;
    const weight = Math.max(0.05, Math.min(1, envWeight));
    result.push({
      time: Math.round(t),
      viseme: set[idx],
      weight: Number(weight.toFixed(3)),
    });
  }
  // Ensure silence at the tail so the mouth closes cleanly.
  if (result.length) {
    result.push({ time: Math.round(durationMs), viseme: set[0], weight: 0 });
  }
  return result;
}

/* ---------------- Emotion ---------------- */

const EMOTION_KEYWORDS = {
  happy: [
    "great", "awesome", "thank", "thanks", "love", "happy", "excited", "wonderful",
    "nice", "excellent", "amazing", "fantastic", "glad", "delighted", "pleased", ":)", "yay",
  ],
  sad: [
    "sad", "sorry", "unhappy", "terrible", "awful", "bad", "hate", "disappointed",
    "regret", "unfortunate", "cry", "crying", "lost", "lonely", "miserable", ":(",
  ],
  surprised: [
    "wow", "whoa", "really", "unbelievable", "no way", "surprise", "shocked",
    "astonished", "incredible", "what?!", "!!!", "omg",
  ],
  focused: [
    "analyze", "computing", "processing", "let me think", "considering", "investigating",
    "calculating", "planning", "step", "approach", "strategy",
  ],
  angry: [
    "angry", "furious", "mad", "annoyed", "frustrated", "damn", "stupid", "hate",
    "unacceptable", "enraged",
  ],
};

/**
 * Rule-based emotion classification of a short text snippet. Returns the
 * dominant emotion and a 0..1 confidence based on keyword density.
 *
 * @param {string} text
 * @returns {{ primary: "happy"|"sad"|"neutral"|"surprised"|"focused"|"angry", confidence: number, scores: object }}
 */
export function computeEmotionFromText(text) {
  const s = typeof text === "string" ? text.toLowerCase() : "";
  if (!s.trim()) {
    return { primary: "neutral", confidence: 0, scores: {} };
  }
  const scores = {};
  let total = 0;
  for (const [label, words] of Object.entries(EMOTION_KEYWORDS)) {
    let hits = 0;
    for (const word of words) {
      if (!word) continue;
      // Count token occurrences; simple indexOf loop so we do not depend on regex escaping.
      let idx = s.indexOf(word);
      while (idx >= 0) {
        hits += 1;
        idx = s.indexOf(word, idx + word.length);
      }
    }
    if (hits > 0) {
      scores[label] = hits;
      total += hits;
    }
  }
  if (total === 0) {
    return { primary: "neutral", confidence: 0, scores: {} };
  }
  let primary = "neutral";
  let best = 0;
  for (const [label, hits] of Object.entries(scores)) {
    if (hits > best) {
      best = hits;
      primary = label;
    }
  }
  // Confidence grows with total keyword hits relative to a small baseline so a
  // single hit is low-confidence but multiple hits saturate toward 1.
  const confidence = Math.max(0, Math.min(1, total / (total + 3)));
  return { primary, confidence: Number(confidence.toFixed(3)), scores };
}

/* ---------------- Idle animation ---------------- */

function hashSeed(seed) {
  const s = String(seed == null ? "default" : seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Normalize into [0, 1)
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

/**
 * Deterministic idle animation sample for a given seed and time.
 * Returns head pitch/yaw in radians plus a breath phase in [0, 1].
 *
 * @param {string|number} seed
 * @param {number} time - seconds
 */
export function computeIdleAnimation(seed, time) {
  const offset = hashSeed(seed) * Math.PI * 2;
  const t = Number.isFinite(time) ? Number(time) : 0;
  const headPitch = 0.08 * Math.sin(t * 0.7 + offset);
  const headYaw = 0.12 * Math.sin(t * 0.5 + offset * 1.3);
  const breathPhase = 0.5 + 0.5 * Math.sin(t * 1.8 + offset);
  return {
    headPitch: Number(headPitch.toFixed(6)),
    headYaw: Number(headYaw.toFixed(6)),
    breathPhase: Number(breathPhase.toFixed(6)),
  };
}

/* ---------------- Session tracking ---------------- */

export async function trackAvatarInSession(sessionId, avatarId) {
  if (!sessionId) throw new Error("sessionId is required");
  if (!avatarId) throw new Error("avatarId is required");
  let list = [];
  await withPathLock(sessionsPath(), async () => {
    const sessions = await loadSessions();
    const current = Array.isArray(sessions[sessionId]) ? sessions[sessionId] : [];
    if (!current.includes(avatarId)) current.push(avatarId);
    sessions[sessionId] = current;
    list = current.slice();
    await saveSessions(sessions);
  });
  return { sessionId, avatarIds: list };
}

export async function getSessionAvatars(sessionId) {
  if (!sessionId) return [];
  const sessions = await loadSessions();
  const ids = Array.isArray(sessions[sessionId]) ? sessions[sessionId] : [];
  if (!ids.length) return [];
  const items = await loadConfigs();
  const byId = new Map(items.map((i) => [i.avatarId, i]));
  return ids.map((id) => publicConfig(byId.get(id))).filter(Boolean);
}

export async function untrackAvatarFromSession(sessionId, avatarId) {
  if (!sessionId) throw new Error("sessionId is required");
  let list = [];
  await withPathLock(sessionsPath(), async () => {
    const sessions = await loadSessions();
    const current = Array.isArray(sessions[sessionId]) ? sessions[sessionId] : [];
    const next = current.filter((a) => a !== avatarId);
    sessions[sessionId] = next;
    list = next;
    await saveSessions(sessions);
  });
  return { sessionId, avatarIds: list };
}

/* ---------------- Pose utilities ---------------- */

function subVec(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function lengthVec(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

/**
 * Compute a look-at pose from `from` toward `target`. Returns the normalized
 * forward vector and euler angles (yaw, pitch) the renderer can apply.
 */
export function lookAtPose(from, target) {
  const a = normalizeVec3(from, [0, 0, 0]);
  const b = normalizeVec3(target, [0, 0, 0]);
  const delta = subVec(b, a);
  const len = lengthVec(delta);
  if (len === 0) {
    return {
      forward: [0, 0, 1],
      yaw: 0,
      pitch: 0,
      length: 0,
    };
  }
  const forward = [delta[0] / len, delta[1] / len, delta[2] / len];
  const yaw = Math.atan2(forward[0], forward[2]);
  const pitch = Math.asin(-forward[1]);
  return {
    forward: [
      Number(forward[0].toFixed(6)),
      Number(forward[1].toFixed(6)),
      Number(forward[2].toFixed(6)),
    ],
    yaw: Number(yaw.toFixed(6)),
    pitch: Number(pitch.toFixed(6)),
    length: Number(len.toFixed(6)),
  };
}

/**
 * Linear interpolation between two poses. Accepts any pose object with vec3
 * fields (position, rotation, scale, lookAt). `t` is clamped to [0, 1].
 */
export function interpolatePose(from, to, t) {
  const alpha = Math.max(0, Math.min(1, Number.isFinite(t) ? Number(t) : 0));
  const src = from && typeof from === "object" ? from : {};
  const dst = to && typeof to === "object" ? to : {};
  const result = {};
  const keys = new Set([...Object.keys(src), ...Object.keys(dst)]);
  for (const key of keys) {
    const a = src[key];
    const b = dst[key];
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      result[key] = a.map((v, i) => {
        const av = Number.isFinite(v) ? Number(v) : 0;
        const bv = Number.isFinite(b[i]) ? Number(b[i]) : 0;
        return av + (bv - av) * alpha;
      });
    } else if (typeof a === "number" && typeof b === "number") {
      result[key] = a + (b - a) * alpha;
    } else if (b !== undefined) {
      result[key] = b;
    } else {
      result[key] = a;
    }
  }
  return result;
}

/** Internal helper exposed for tests only. */
export const _internals = {
  normalizeVec3,
  normalizeModelRef,
  hashSeed,
  configsPath,
  statesPath,
  sessionsPath,
};
