// @ts-check
/**
 * Phase 49.5: Collaborative VR rooms.
 *
 * Multi-user shared VR workspace sessions. Tracks room metadata, participants,
 * per-participant poses (head + hands + velocity), shared scene objects, and
 * per-participant voice state. Sync is delegated to the existing realtime
 * layer — this module only owns durable state and structured event payloads.
 *
 * Storage: JSON-backed via `json-path-store.js` so it works across file,
 * SQLite, or Postgres KV backends without code changes.
 *
 * @module vr-rooms
 */
import crypto from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const STORE_VERSION = 1;
const DEFAULT_MAX_PARTICIPANTS = 16;
const HARD_MAX_PARTICIPANTS = 128;
const DEFAULT_THEME = "neutral";
const DEFAULT_ROOM_LAYOUT = "circle";

function storePath() {
  return join(getDataDir(), "vr-rooms.json");
}

function now() {
  return Date.now();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeStore(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    _version: STORE_VERSION,
    rooms: base.rooms && typeof base.rooms === "object" ? base.rooms : {},
  };
}

async function loadStore() {
  return normalizeStore(
    await readJsonPath(storePath(), { _version: STORE_VERSION, rooms: {} }),
  );
}

async function saveStore(store) {
  await writeJsonPath(storePath(), store);
}

async function mutate(fn) {
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const result = await fn(store);
    await saveStore(store);
    return result;
  });
}

function ensureRoomShape(room) {
  if (!room || typeof room !== "object") return null;
  if (!room.participants || typeof room.participants !== "object") room.participants = {};
  if (!room.objects || typeof room.objects !== "object") room.objects = {};
  if (typeof room.maxParticipants !== "number") room.maxParticipants = DEFAULT_MAX_PARTICIPANTS;
  if (typeof room.isPublic !== "boolean") room.isPublic = true;
  if (typeof room.theme !== "string") room.theme = DEFAULT_THEME;
  if (typeof room.layout !== "string") room.layout = DEFAULT_ROOM_LAYOUT;
  return room;
}

function cloneRoom(room) {
  if (!room) return null;
  try {
    return structuredClone(room);
  } catch {
    return JSON.parse(JSON.stringify(room));
  }
}

function sanitizeString(v, max = 200) {
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ---- Rooms ----

/**
 * Create a new VR room.
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} [opts.workspaceId]
 * @param {number} [opts.maxParticipants]
 * @param {boolean} [opts.isPublic]
 * @param {string} [opts.theme]
 * @param {string} [opts.layout]
 * @param {string} [opts.ownerId]
 * @returns {Promise<object>}
 */
export async function createRoom({
  name,
  workspaceId = "default",
  maxParticipants = DEFAULT_MAX_PARTICIPANTS,
  isPublic = true,
  theme = DEFAULT_THEME,
  layout = DEFAULT_ROOM_LAYOUT,
  ownerId = null,
} = {}) {
  const cleanName = sanitizeString(name, 120).trim();
  if (!cleanName) throw new Error("name is required");
  const cap = clampNumber(maxParticipants, 1, HARD_MAX_PARTICIPANTS, DEFAULT_MAX_PARTICIPANTS);
  const roomId = randomId("room");
  const room = {
    roomId,
    name: cleanName,
    workspaceId: sanitizeString(workspaceId, 120) || "default",
    ownerId: ownerId ? sanitizeString(ownerId, 120) : null,
    maxParticipants: cap,
    isPublic: Boolean(isPublic),
    theme: sanitizeString(theme, 60) || DEFAULT_THEME,
    layout: sanitizeString(layout, 60) || DEFAULT_ROOM_LAYOUT,
    createdAt: now(),
    updatedAt: now(),
    participants: {},
    objects: {},
  };
  await mutate(async (store) => {
    store.rooms[roomId] = room;
  });
  return cloneRoom(room);
}

/**
 * Get a room by id.
 * @param {string} roomId
 * @returns {Promise<object|null>}
 */
export async function getRoom(roomId) {
  if (typeof roomId !== "string" || !roomId) return null;
  const store = await loadStore();
  const room = ensureRoomShape(store.rooms[roomId]);
  return cloneRoom(room);
}

/**
 * List rooms, optionally filtered.
 * @param {object} [filter]
 * @param {string} [filter.workspaceId]
 * @param {boolean} [filter.isPublic]
 * @param {string} [filter.ownerId]
 * @returns {Promise<object[]>}
 */
export async function listRooms(filter = {}) {
  const store = await loadStore();
  let rooms = Object.values(store.rooms).map(ensureRoomShape).filter(Boolean);
  if (filter && typeof filter === "object") {
    if (typeof filter.workspaceId === "string" && filter.workspaceId) {
      rooms = rooms.filter((r) => r.workspaceId === filter.workspaceId);
    }
    if (typeof filter.isPublic === "boolean") {
      rooms = rooms.filter((r) => r.isPublic === filter.isPublic);
    }
    if (typeof filter.ownerId === "string" && filter.ownerId) {
      rooms = rooms.filter((r) => r.ownerId === filter.ownerId);
    }
  }
  rooms.sort((a, b) => b.createdAt - a.createdAt);
  return rooms.map(cloneRoom);
}

/**
 * Apply a shallow merge to a room's metadata fields.
 * @param {string} roomId
 * @param {object} updates
 * @returns {Promise<object>}
 */
export async function updateRoom(roomId, updates) {
  if (typeof roomId !== "string" || !roomId) throw new Error("roomId is required");
  if (!updates || typeof updates !== "object") throw new Error("updates is required");
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) throw new Error(`room ${roomId} not found`);
    if (typeof updates.name === "string") {
      const n = sanitizeString(updates.name, 120).trim();
      if (n) room.name = n;
    }
    if (typeof updates.maxParticipants === "number") {
      room.maxParticipants = clampNumber(
        updates.maxParticipants,
        1,
        HARD_MAX_PARTICIPANTS,
        room.maxParticipants,
      );
    }
    if (typeof updates.isPublic === "boolean") room.isPublic = updates.isPublic;
    if (typeof updates.theme === "string") room.theme = sanitizeString(updates.theme, 60) || room.theme;
    if (typeof updates.layout === "string") room.layout = sanitizeString(updates.layout, 60) || room.layout;
    if (typeof updates.ownerId === "string") room.ownerId = sanitizeString(updates.ownerId, 120);
    room.updatedAt = now();
    return cloneRoom(room);
  });
}

/**
 * Delete a room.
 * @param {string} roomId
 * @returns {Promise<boolean>}
 */
export async function deleteRoom(roomId) {
  if (typeof roomId !== "string" || !roomId) return false;
  return mutate(async (store) => {
    if (!store.rooms[roomId]) return false;
    delete store.rooms[roomId];
    return true;
  });
}

// ---- Participants ----

/**
 * Join a room as a new participant.
 * @param {string} roomId
 * @param {string} userId
 * @param {string} displayName
 * @param {string} [avatarId]
 * @returns {Promise<{participantId:string, token:string, spawnPosition:number[], room:object}>}
 */
export async function joinRoom(roomId, userId, displayName, avatarId = "default") {
  if (typeof roomId !== "string" || !roomId) throw new Error("roomId is required");
  if (typeof userId !== "string" || !userId) throw new Error("userId is required");
  if (typeof displayName !== "string" || !displayName) throw new Error("displayName is required");
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) throw new Error(`room ${roomId} not found`);
    const count = Object.keys(room.participants).length;
    if (count >= room.maxParticipants) {
      throw new Error(`room ${roomId} is at capacity (${room.maxParticipants})`);
    }
    const participantId = randomId("p");
    const token = crypto.randomBytes(24).toString("hex");
    const spawnPosition = computeSpawnPosition(count, room.layout);
    const participant = {
      participantId,
      userId: sanitizeString(userId, 120),
      displayName: sanitizeString(displayName, 120),
      avatarId: sanitizeString(avatarId, 120) || "default",
      token,
      joinedAt: now(),
      lastSeenAt: now(),
      spawnPosition,
      pose: {
        head: { position: spawnPosition.slice(), rotation: [0, 0, 0, 1] },
        hands: {
          left: { position: [spawnPosition[0] - 0.2, spawnPosition[1], spawnPosition[2]], rotation: [0, 0, 0, 1] },
          right: { position: [spawnPosition[0] + 0.2, spawnPosition[1], spawnPosition[2]], rotation: [0, 0, 0, 1] },
        },
        velocity: [0, 0, 0],
      },
      voice: { muted: false, speaking: false, volume: 1 },
    };
    room.participants[participantId] = participant;
    room.updatedAt = now();
    return { participantId, token, spawnPosition, room: cloneRoom(room) };
  });
}

/**
 * Remove a participant from a room.
 * @param {string} roomId
 * @param {string} participantId
 * @returns {Promise<boolean>}
 */
export async function leaveRoom(roomId, participantId) {
  if (typeof roomId !== "string" || !roomId) return false;
  if (typeof participantId !== "string" || !participantId) return false;
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) return false;
    if (!room.participants[participantId]) return false;
    delete room.participants[participantId];
    room.updatedAt = now();
    return true;
  });
}

/**
 * List all current participants of a room.
 * @param {string} roomId
 * @returns {Promise<object[]>}
 */
export async function getParticipants(roomId) {
  if (typeof roomId !== "string" || !roomId) return [];
  const store = await loadStore();
  const room = ensureRoomShape(store.rooms[roomId]);
  if (!room) return [];
  return Object.values(room.participants)
    .map((p) => {
      // Do not leak the session token in listings.
      const { token: _token, ...rest } = p;
      return cloneRoom(rest);
    })
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

// ---- Pose sync ----

function normalizeVec3(v, fallback = [0, 0, 0]) {
  if (!Array.isArray(v) || v.length < 3) return fallback.slice();
  return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

function normalizeQuat(v, fallback = [0, 0, 0, 1]) {
  if (!Array.isArray(v) || v.length < 4) return fallback.slice();
  return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0, Number(v[3]) || 0];
}

function normalizePose(pose) {
  const src = pose && typeof pose === "object" ? pose : {};
  const head = src.head && typeof src.head === "object" ? src.head : {};
  const hands = src.hands && typeof src.hands === "object" ? src.hands : {};
  const left = hands.left && typeof hands.left === "object" ? hands.left : {};
  const right = hands.right && typeof hands.right === "object" ? hands.right : {};
  return {
    head: {
      position: normalizeVec3(head.position),
      rotation: normalizeQuat(head.rotation),
    },
    hands: {
      left: { position: normalizeVec3(left.position), rotation: normalizeQuat(left.rotation) },
      right: { position: normalizeVec3(right.position), rotation: normalizeQuat(right.rotation) },
    },
    velocity: normalizeVec3(src.velocity),
  };
}

/**
 * Update a participant's pose.
 * @param {string} roomId
 * @param {string} participantId
 * @param {object} pose
 * @returns {Promise<object>}
 */
export async function updateParticipantPose(roomId, participantId, pose) {
  if (typeof roomId !== "string" || !roomId) throw new Error("roomId is required");
  if (typeof participantId !== "string" || !participantId) throw new Error("participantId is required");
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) throw new Error(`room ${roomId} not found`);
    const participant = room.participants[participantId];
    if (!participant) throw new Error(`participant ${participantId} not found`);
    participant.pose = normalizePose(pose);
    participant.lastSeenAt = now();
    room.updatedAt = now();
    return cloneRoom(participant.pose);
  });
}

/**
 * Get a participant's current pose.
 * @param {string} roomId
 * @param {string} participantId
 * @returns {Promise<object|null>}
 */
export async function getParticipantPose(roomId, participantId) {
  if (typeof roomId !== "string" || !roomId) return null;
  if (typeof participantId !== "string" || !participantId) return null;
  const store = await loadStore();
  const room = ensureRoomShape(store.rooms[roomId]);
  if (!room) return null;
  const participant = room.participants[participantId];
  if (!participant) return null;
  return cloneRoom(participant.pose);
}

// ---- Shared objects ----

/**
 * Spawn a new object in a room.
 * @param {string} roomId
 * @param {object} object - { type, position, rotation, owner, properties }
 * @returns {Promise<object>}
 */
export async function spawnObject(roomId, object) {
  if (typeof roomId !== "string" || !roomId) throw new Error("roomId is required");
  if (!object || typeof object !== "object") throw new Error("object is required");
  const type = sanitizeString(object.type, 60);
  if (!type) throw new Error("object.type is required");
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) throw new Error(`room ${roomId} not found`);
    const objectId = randomId("obj");
    const entry = {
      objectId,
      type,
      position: normalizeVec3(object.position),
      rotation: normalizeQuat(object.rotation),
      owner: object.owner ? sanitizeString(object.owner, 120) : null,
      properties: object.properties && typeof object.properties === "object" ? { ...object.properties } : {},
      createdAt: now(),
      updatedAt: now(),
    };
    room.objects[objectId] = entry;
    room.updatedAt = now();
    return cloneRoom(entry);
  });
}

/**
 * Shallow-merge updates into a room object.
 * @param {string} roomId
 * @param {string} objectId
 * @param {object} updates
 * @returns {Promise<object>}
 */
export async function updateObject(roomId, objectId, updates) {
  if (typeof roomId !== "string" || !roomId) throw new Error("roomId is required");
  if (typeof objectId !== "string" || !objectId) throw new Error("objectId is required");
  if (!updates || typeof updates !== "object") throw new Error("updates is required");
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) throw new Error(`room ${roomId} not found`);
    const obj = room.objects[objectId];
    if (!obj) throw new Error(`object ${objectId} not found`);
    if (typeof updates.type === "string") {
      const t = sanitizeString(updates.type, 60);
      if (t) obj.type = t;
    }
    if (updates.position !== undefined) obj.position = normalizeVec3(updates.position, obj.position);
    if (updates.rotation !== undefined) obj.rotation = normalizeQuat(updates.rotation, obj.rotation);
    if (typeof updates.owner === "string") obj.owner = sanitizeString(updates.owner, 120);
    if (updates.properties && typeof updates.properties === "object") {
      obj.properties = { ...obj.properties, ...updates.properties };
    }
    obj.updatedAt = now();
    room.updatedAt = now();
    return cloneRoom(obj);
  });
}

/**
 * Remove an object from a room.
 * @param {string} roomId
 * @param {string} objectId
 * @returns {Promise<boolean>}
 */
export async function removeObject(roomId, objectId) {
  if (typeof roomId !== "string" || !roomId) return false;
  if (typeof objectId !== "string" || !objectId) return false;
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) return false;
    if (!room.objects[objectId]) return false;
    delete room.objects[objectId];
    room.updatedAt = now();
    return true;
  });
}

/**
 * List every object currently present in a room.
 * @param {string} roomId
 * @returns {Promise<object[]>}
 */
export async function getRoomObjects(roomId) {
  if (typeof roomId !== "string" || !roomId) return [];
  const store = await loadStore();
  const room = ensureRoomShape(store.rooms[roomId]);
  if (!room) return [];
  return Object.values(room.objects)
    .map(cloneRoom)
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ---- Voice channels ----

/**
 * Set a participant's voice state.
 * @param {string} roomId
 * @param {string} participantId
 * @param {{muted?:boolean, speaking?:boolean, volume?:number}} state
 * @returns {Promise<object>}
 */
export async function setVoiceState(roomId, participantId, state) {
  if (typeof roomId !== "string" || !roomId) throw new Error("roomId is required");
  if (typeof participantId !== "string" || !participantId) throw new Error("participantId is required");
  const src = state && typeof state === "object" ? state : {};
  return mutate(async (store) => {
    const room = ensureRoomShape(store.rooms[roomId]);
    if (!room) throw new Error(`room ${roomId} not found`);
    const participant = room.participants[participantId];
    if (!participant) throw new Error(`participant ${participantId} not found`);
    const current = participant.voice || { muted: false, speaking: false, volume: 1 };
    const next = {
      muted: typeof src.muted === "boolean" ? src.muted : current.muted,
      speaking: typeof src.speaking === "boolean" ? src.speaking : current.speaking,
      volume:
        typeof src.volume === "number" && Number.isFinite(src.volume)
          ? clampNumber(src.volume, 0, 1, current.volume)
          : current.volume,
    };
    participant.voice = next;
    participant.lastSeenAt = now();
    room.updatedAt = now();
    return cloneRoom(next);
  });
}

// ---- Spawn logic ----

/**
 * Deterministically compute a non-overlapping spawn position based on the
 * current participant count and the room layout. Positions are placed on
 * a unit circle (or grid, for "grid" layout) at eye height.
 * @param {number} participantCount
 * @param {string} [roomLayout]
 * @returns {number[]}
 */
export function computeSpawnPosition(participantCount, roomLayout = DEFAULT_ROOM_LAYOUT) {
  const idx = Number.isFinite(participantCount) && participantCount >= 0 ? Math.floor(participantCount) : 0;
  const eyeHeight = 1.6;
  if (roomLayout === "grid") {
    const spacing = 1.5;
    const side = Math.max(1, Math.ceil(Math.sqrt(idx + 1)));
    const row = Math.floor(idx / side);
    const col = idx % side;
    return [col * spacing - ((side - 1) * spacing) / 2, eyeHeight, row * spacing - ((side - 1) * spacing) / 2];
  }
  if (roomLayout === "line") {
    return [idx * 1.2 - 3, eyeHeight, 0];
  }
  // Default: circle layout at radius 2.5
  const radius = 2.5;
  // Use a golden-angle stride so neighbors never stack exactly.
  const step = (2 * Math.PI) / Math.max(8, idx + 2);
  const angle = idx * step;
  return [Math.cos(angle) * radius, eyeHeight, Math.sin(angle) * radius];
}

// ---- Capacity ----

/**
 * Get the capacity state for a room.
 * @param {string} roomId
 * @returns {Promise<{roomId:string, current:number, max:number, available:number, full:boolean}|null>}
 */
export async function checkCapacity(roomId) {
  if (typeof roomId !== "string" || !roomId) return null;
  const store = await loadStore();
  const room = ensureRoomShape(store.rooms[roomId]);
  if (!room) return null;
  const current = Object.keys(room.participants).length;
  const max = room.maxParticipants;
  return {
    roomId,
    current,
    max,
    available: Math.max(0, max - current),
    full: current >= max,
  };
}

// ---- Event helper ----

/**
 * Build a structured room event suitable for broadcasting over the realtime
 * layer. No side-effects.
 * @param {string} type
 * @param {string} roomId
 * @param {object} [payload]
 * @returns {object}
 */
export function buildRoomEvent(type, roomId, payload = {}) {
  return {
    channel: `vr-room:${roomId}`,
    type: String(type || "vr.room.event"),
    roomId: String(roomId || ""),
    payload: payload && typeof payload === "object" ? payload : {},
    at: now(),
  };
}

export const _internals = {
  storePath,
  normalizePose,
  normalizeVec3,
  normalizeQuat,
};
