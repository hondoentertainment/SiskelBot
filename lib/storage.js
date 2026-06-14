// @ts-check
/**
 * Phase 10: Persistent backend storage for SiskelBot.
 * Phase 14: Scoped by userId + workspaceId: data/users/{userId}/workspaces/{workspaceId}/
 * Phase 29: Team workspaces (type: "personal" | "team"), members, roles.
 * Phase 46: Optional PostgreSQL KV (STORAGE_BACKEND=postgres + DATABASE_URL) — async reads/writes.
 * Phase 40.3: Per-workspace residency routing — reads/writes are checked against
 *             the workspace's pinned region and routed to a regional sub-directory.
 * @module storage
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { getWorkspacesForMember } from "./teams.js";
import { join, dirname } from "path";
import { sqliteKvLoad, sqliteKvSave, sqliteKvEnabled } from "./storage-sqlite-kv.js";
import { postgresKvLoad, postgresKvSave, postgresKvEnabled } from "./storage-postgres-kv.js";
import { randomUUID } from "crypto";
import {
  encryptFields,
  decryptFields,
  computeBlindIndexes,
  canEncrypt,
} from "./field-encryption.js";
import {
  getWorkspaceResidency,
  enforceResidency,
  getInstanceRegion,
  recordViolation,
} from "./data-residency.js";

const STORAGE_VERSION = 1;

// Phase 36.4: Per-collection encrypted field configuration. Keys are storage
// types ("context", "recipes", "conversations", ...). Values are arrays of
// custom encrypted field names that are merged with the always-encrypted list
// on top of the base set defined in lib/field-encryption.js.
/** @type {Map<string, string[]>} */
const _collectionEncryptedFields = new Map();

/**
 * Configure additional encrypted field names for a storage collection.
 * @param {string} type
 * @param {string[]} fields
 */
export function configureEncryptedFields(type, fields) {
  if (!type) return;
  _collectionEncryptedFields.set(String(type), Array.isArray(fields) ? fields.slice() : []);
}

/**
 * Get the configured custom encrypted fields for a collection.
 * @param {string} type
 * @returns {string[]}
 */
export function getConfiguredEncryptedFields(type) {
  return _collectionEncryptedFields.get(String(type)) || [];
}

function isEncryptionOn() {
  return canEncrypt();
}

/**
 * Encrypt an item (in place clone) and attach blind indexes under `_blindIndex`.
 * @param {string} type
 * @param {any} item
 * @returns {any}
 */
function encryptItemForWrite(type, item) {
  if (!isEncryptionOn()) return item;
  if (!item || typeof item !== "object") return item;
  const customFields = getConfiguredEncryptedFields(type);
  const indexes = computeBlindIndexes(item, customFields);
  const enc = /** @type {any} */ (encryptFields(item, customFields));
  if (Object.keys(indexes).length > 0) {
    enc._blindIndex = { ...(enc._blindIndex || {}), ...indexes };
  }
  return enc;
}

/**
 * Decrypt envelopes on an item when reading.
 * @param {any} item
 * @returns {any}
 */
function decryptItemForRead(item) {
  if (!isEncryptionOn()) return item;
  if (!item || typeof item !== "object") return item;
  return decryptFields(item);
}

function tagEncryptedMeta(data, type) {
  if (!data || typeof data !== "object") return data;
  if (!isEncryptionOn()) return data;
  const custom = getConfiguredEncryptedFields(type);
  if (custom.length === 0) return data;
  data._encrypted_fields = custom.slice();
  return data;
}
const WORKSPACE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,49}$/;
const USER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

const locks = new Map();

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function getDataDir() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  ensureDir(dir);
  return dir;
}

/**
 * Sanitize a userId string to a safe filesystem-compatible value.
 * @param {string} uid
 * @returns {string}
 */
export function sanitizeUserId(uid) {
  if (typeof uid !== "string" || !String(uid).trim()) return "anonymous";
  const s = String(uid).trim().slice(0, 100);
  return USER_ID_PATTERN.test(s) ? s : "anonymous";
}

/**
 * Sanitize a workspace identifier to a safe filesystem-compatible value.
 * @param {string} ws
 * @returns {string}
 */
export function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  const s = String(ws).trim().slice(0, 50);
  return WORKSPACE_PATTERN.test(s) ? s : "default";
}

function getFilePath(type, userId, workspaceId, region = null) {
  const dir = getDataDir();
  const files = { context: "context.json", recipes: "recipes.json", conversations: "conversations.json" };
  const name = files[type];
  if (!name) throw new Error(`Unknown storage type: ${type}`);
  const uid = sanitizeUserId(userId);
  const ws = sanitizeWorkspace(workspaceId);
  if (region && typeof region === "string") {
    // Phase 40.3: route to a regional sub-directory so that operators can mount
    // a different filesystem / volume per region.
    const safeRegion = region.replace(/[^a-z0-9-]/g, "");
    if (safeRegion) {
      return join(dir, "regions", safeRegion, "users", uid, "workspaces", ws, name);
    }
  }
  return join(dir, "users", uid, "workspaces", ws, name);
}

/**
 * Resolve the residency-aware file path for a workspace operation. Performs the
 * residency enforcement check and logs violations to the audit store. When the
 * operation is denied a structured Error is thrown.
 *
 * @param {string} type
 * @param {string} userId
 * @param {string} workspaceId
 * @param {"read" | "write" | "delete"} operation
 * @returns {Promise<string>}
 */
async function resolveResidencyPath(type, userId, workspaceId, operation) {
  let record = null;
  try {
    record = await getWorkspaceResidency(workspaceId);
  } catch (e) {
    console.warn("[storage] residency lookup failed:", e.message);
  }
  if (!record) {
    return getFilePath(type, userId, workspaceId);
  }
  let result;
  try {
    result = await enforceResidency(workspaceId, operation);
  } catch (e) {
    console.warn("[storage] residency enforcement failed:", e.message);
    return getFilePath(type, userId, workspaceId, record.region);
  }
  if (!result.allowed) {
    try {
      await recordViolation({
        workspaceId,
        sourceRegion: getInstanceRegion(),
        targetRegion: record.region,
        operation,
        reason: result.reason || "residency_violation",
        type,
      });
    } catch (_) {
      /* ignore audit failures */
    }
    const err = new Error(result.reason || `Residency violation for ${operation} on ${workspaceId}`);
    /** @type {any} */ (err).code = "RESIDENCY_VIOLATION";
    /** @type {any} */ (err).workspaceId = workspaceId;
    /** @type {any} */ (err).region = record.region;
    throw err;
  }
  return getFilePath(type, userId, workspaceId, record.region);
}

function getLegacyFilePath(type) {
  const dir = getDataDir();
  const files = { context: "context.json", recipes: "recipes.json", conversations: "conversations.json" };
  const name = files[type];
  if (!name) throw new Error(`Unknown storage type: ${type}`);
  return join(dir, name);
}

/** @returns {object} */
function loadLegacyJsonFileOnly(filePath) {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf8"));
    }
  } catch (e) {
    console.warn("[storage] Legacy read failed", filePath, e.message);
  }
  return { _version: STORAGE_VERSION, items: [] };
}

/**
 * @param {string} filePath
 * @returns {Promise<object>}
 */
async function loadRaw(filePath) {
  if (postgresKvEnabled()) {
    const fromPg = await postgresKvLoad(filePath);
    if (fromPg != null && typeof fromPg === "object") return fromPg;
    return { _version: STORAGE_VERSION, items: [] };
  }
  if (sqliteKvEnabled()) {
    const fromSql = sqliteKvLoad(filePath, getDataDir);
    if (fromSql != null && typeof fromSql === "object") return fromSql;
  }
  try {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn("[storage] Failed to load", filePath, e.message);
  }
  return { _version: STORAGE_VERSION, items: [] };
}

/**
 * @param {string} filePath
 * @param {object} data
 */
async function saveRaw(filePath, data) {
  if (postgresKvEnabled()) {
    const ok = await postgresKvSave(filePath, data);
    if (!ok) console.error("[storage] Postgres save failed for", filePath);
    return;
  }
  if (sqliteKvEnabled() && sqliteKvSave(filePath, data, getDataDir)) {
    return;
  }
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 0), "utf8");
}

function withLock(filePath, fn) {
  let queue = locks.get(filePath);
  if (!queue) {
    queue = Promise.resolve();
    locks.set(filePath, queue);
  }
  const next = queue.then(() => fn()).catch((e) => {
    throw e;
  });
  locks.set(filePath, next);
  return next;
}

async function migrateLegacyIfNeeded(type, userId, workspaceId) {
  if (postgresKvEnabled()) return;
  const uid = sanitizeUserId(userId);
  const ws = sanitizeWorkspace(workspaceId);
  if (uid !== "anonymous" || ws !== "default") return;
  const legacyPath = getLegacyFilePath(type);
  const newPath = getFilePath(type, userId, workspaceId);
  if (!existsSync(legacyPath) || existsSync(newPath)) return;
  try {
    const data = loadLegacyJsonFileOnly(legacyPath);
    if (Array.isArray(data.items) && data.items.length > 0) {
      await saveRaw(newPath, data);
      console.log("[storage] Migrated legacy", type, "to", newPath);
    }
  } catch (e) {
    console.warn("[storage] Migration failed for", type, e.message);
  }
}

function getWorkspacesMetaPath(userId) {
  const dir = getDataDir();
  const uid = sanitizeUserId(userId);
  return join(dir, "users", uid, "workspaces.json");
}

/**
 * List all items of a given storage type within a workspace.
 * @param {SiskelBot.StorageType} type
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<SiskelBot.StorageItem[]>}
 */
export async function list(type, workspace = "default", userId = "anonymous") {
  await migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = await resolveResidencyPath(type, userId, workspace, "read");
  const data = await loadRaw(filePath);
  const items = Array.isArray(data.items) ? data.items : [];
  if (!isEncryptionOn()) return items;
  return items.map((i) => decryptItemForRead(i));
}

/**
 * Get a single item by id.
 * @param {SiskelBot.StorageType} type
 * @param {string} id
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<SiskelBot.StorageItem | null>}
 */
export async function get(type, id, workspace = "default", userId = "anonymous") {
  const items = await list(type, workspace, userId);
  return items.find((i) => String(i.id) === String(id)) || null;
}

/**
 * Add one or more items to storage.
 * @param {SiskelBot.StorageType} type
 * @param {SiskelBot.StorageItem | SiskelBot.StorageItem[]} itemOrItems
 * @param {string} [workspace]
 * @param {boolean} [merge] - When true, update existing items by id instead of skipping
 * @param {string} [userId]
 * @returns {Promise<SiskelBot.StorageItem | SiskelBot.StorageItem[]>}
 */
export async function add(type, itemOrItems, workspace = "default", merge = false, userId = "anonymous") {
  await migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = await resolveResidencyPath(type, userId, workspace, "write");
  const ws = sanitizeWorkspace(workspace);
  return withLock(filePath, async () => {
    const data = await loadRaw(filePath);
    let items = Array.isArray(data.items) ? data.items : [];
    const incoming = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];

    incoming.forEach((it) => {
      const item = { ...it, workspace: ws };
      if (!item.id) item.id = randomUUID();
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      const idx = items.findIndex((i) => String(i.id) === String(item.id));
      const prepared = encryptItemForWrite(type, item);
      if (merge && idx >= 0) {
        items[idx] = { ...items[idx], ...prepared };
      } else if (idx < 0) {
        items.push(prepared);
      }
    });
    data._version = STORAGE_VERSION;
    data.items = items;
    tagEncryptedMeta(data, type);
    await saveRaw(filePath, data);
    const resultItems = isEncryptionOn() ? items.map((i) => decryptItemForRead(i)) : items;
    return merge ? resultItems : resultItems[resultItems.length - 1];
  });
}

/**
 * Merge client items with stored items (upsert by id).
 * @param {SiskelBot.StorageType} type
 * @param {SiskelBot.StorageItem[]} clientItems
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<SiskelBot.StorageItem[]>}
 */
export async function mergeSync(type, clientItems, workspace = "default", userId = "anonymous") {
  await migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = await resolveResidencyPath(type, userId, workspace, "write");
  const ws = sanitizeWorkspace(workspace);
  return withLock(filePath, async () => {
    const data = await loadRaw(filePath);
    let items = Array.isArray(data.items) ? data.items : [];
    const incoming = Array.isArray(clientItems) ? clientItems : [];
    const byId = new Map(items.map((i) => [String(i.id), { ...i }]));
    incoming.forEach((it) => {
      const item = { ...it };
      if (!item.id) item.id = randomUUID();
      item.workspace = ws;
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      item.updatedAt = new Date().toISOString();
      byId.set(String(item.id), encryptItemForWrite(type, item));
    });
    items = Array.from(byId.values()).filter((i) => i.workspace === ws);
    data._version = STORAGE_VERSION;
    data.items = items;
    tagEncryptedMeta(data, type);
    await saveRaw(filePath, data);
    return isEncryptionOn() ? items.map((i) => decryptItemForRead(i)) : items;
  });
}

/**
 * Replace all items of a given type in the workspace.
 * @param {SiskelBot.StorageType} type
 * @param {SiskelBot.StorageItem[]} newItems
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<SiskelBot.StorageItem[]>}
 */
export async function replace(type, newItems, workspace = "default", userId = "anonymous") {
  await migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = await resolveResidencyPath(type, userId, workspace, "write");
  const ws = sanitizeWorkspace(workspace);
  return withLock(filePath, async () => {
    const normalized = (Array.isArray(newItems) ? newItems : []).map((it) => ({
      ...it,
      workspace: ws,
      createdAt: it.createdAt || new Date().toISOString(),
    }));
    const stored = normalized.map((it) => encryptItemForWrite(type, it));
    /** @type {any} */
    const data = { _version: STORAGE_VERSION, items: stored };
    tagEncryptedMeta(data, type);
    await saveRaw(filePath, data);
    return isEncryptionOn() ? stored.map((i) => decryptItemForRead(i)) : stored;
  });
}

/**
 * Update an existing item by id with partial data.
 * @param {SiskelBot.StorageType} type
 * @param {string} id
 * @param {Partial<SiskelBot.StorageItem>} updates
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<SiskelBot.StorageItem | null>}
 */
export async function update(type, id, updates, workspace = "default", userId = "anonymous") {
  const filePath = await resolveResidencyPath(type, userId, workspace, "write");
  return withLock(filePath, async () => {
    const data = await loadRaw(filePath);
    const items = Array.isArray(data.items) ? data.items : [];
    const idx = items.findIndex((i) => String(i.id) === String(id));
    if (idx < 0) return null;
    const existingPlain = decryptItemForRead(items[idx]);
    const merged = { ...existingPlain, ...updates, id: existingPlain.id, updatedAt: new Date().toISOString() };
    items[idx] = encryptItemForWrite(type, merged);
    data.items = items;
    tagEncryptedMeta(data, type);
    await saveRaw(filePath, data);
    return isEncryptionOn() ? decryptItemForRead(items[idx]) : items[idx];
  });
}

/**
 * Remove an item by id.
 * @param {SiskelBot.StorageType} type
 * @param {string} id
 * @param {string} [workspace]
 * @param {string} [userId]
 * @returns {Promise<boolean>}
 */
export async function remove(type, id, workspace = "default", userId = "anonymous") {
  const filePath = await resolveResidencyPath(type, userId, workspace, "delete");
  return withLock(filePath, async () => {
    const data = await loadRaw(filePath);
    const items = Array.isArray(data.items) ? data.items : [];
    const before = items.length;
    data.items = items.filter((i) => String(i.id) !== String(id));
    if (data.items.length === before) return false;
    await saveRaw(filePath, data);
    return true;
  });
}

// --- Workspaces metadata ---
/**
 * @param {string} ownerId
 * @param {string} workspaceId
 * @returns {Promise<object | null>}
 */
export async function getWorkspaceById(ownerId, workspaceId) {
  const path = getWorkspacesMetaPath(ownerId);
  const data = await loadRaw(path);
  const items = Array.isArray(data.items) ? data.items : [];
  return items.find((w) => String(w.id) === String(workspaceId)) || null;
}

/**
 * List all workspaces accessible to a user (owned + team memberships).
 * @param {string} [userId]
 * @returns {Promise<SiskelBot.Workspace[]>}
 */
export async function listWorkspaces(userId = "anonymous") {
  const uid = sanitizeUserId(userId);
  const defaultWs = { id: "default", name: "Default", userId: uid, createdAt: new Date(0).toISOString(), type: "personal" };
  const path = getWorkspacesMetaPath(userId);
  /** @type {object[]} */
  let ownItems;
  try {
    const data = await loadRaw(path);
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length > 0) {
      ownItems = items.map((w) => ({ ...w, type: w.type || "personal" }));
      const hasDefault = ownItems.some((w) => String(w.id) === "default");
      if (!hasDefault) ownItems = [defaultWs, ...ownItems];
    } else {
      ownItems = [defaultWs];
    }
  } catch (e) {
    console.warn("[storage] Failed to load workspaces", e.message);
    ownItems = [defaultWs];
  }
  try {
    const memberOf = await getWorkspacesForMember(uid);
    for (const { workspaceId, ownerId } of memberOf) {
      if (ownItems.some((w) => String(w.id) === String(workspaceId))) continue;
      const ws = await getWorkspaceById(ownerId, workspaceId);
      if (ws) ownItems.push({ ...ws, type: ws.type || "team" });
    }
  } catch (e) {
    console.warn("[storage] Team workspaces merge failed", e.message);
  }
  return ownItems;
}

/**
 * Remove a workspace id from the owner's workspaces.json (not default).
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function removeWorkspaceFromOwnerList(userId, workspaceId) {
  if (String(workspaceId) === "default") {
    return { ok: false, error: "cannot_delete_default" };
  }
  const uid = sanitizeUserId(userId);
  const path = getWorkspacesMetaPath(uid);
  return withLock(path, async () => {
    const data = await loadRaw(path);
    const items = Array.isArray(data.items) ? data.items : [];
    const next = items.filter((w) => String(w.id) !== String(workspaceId));
    if (next.length === items.length) return { ok: false, error: "workspace_not_in_list" };
    data.items = next;
    data._version = STORAGE_VERSION;
    await saveRaw(path, data);
    return { ok: true };
  });
}

/**
 * Create a new workspace for a user.
 * @param {string} userId
 * @param {string} name
 * @param {"personal" | "team"} [type]
 * @returns {Promise<SiskelBot.Workspace>}
 */
export async function createWorkspace(userId, name, type = "personal") {
  const uid = sanitizeUserId(userId);
  const safeName = typeof name === "string" ? name.trim().slice(0, 100) : "Workspace";
  const wsType = type === "team" ? "team" : "personal";
  const id = randomUUID();
  const path = getWorkspacesMetaPath(userId);
  return withLock(path, async () => {
    const all = await listWorkspaces(userId);
    const items = all.filter((w) => w.id !== "default");
    /** @type {SiskelBot.Workspace} */
    const ws = { id, name: safeName || "Workspace", userId: uid, createdAt: new Date().toISOString(), type: wsType };
    items.push(ws);
    const data = { _version: 1, items: [{ id: "default", name: "Default", userId: uid, createdAt: new Date(0).toISOString(), type: "personal" }, ...items] };
    await saveRaw(path, data);
    if (wsType === "team") {
      const { registerWorkspaceMembers } = await import("./teams.js");
      await registerWorkspaceMembers(id, uid, [{ userId: uid, role: "admin" }]);
    }
    return ws;
  });
}

// --- Server API compatibility ---
export async function listItems(type, workspace = "default", userId = "anonymous") {
  return list(type, workspace, userId);
}
export async function getItem(type, id, workspace = "default", userId = "anonymous") {
  return get(type, id, workspace, userId);
}
export async function mergeItems(type, workspace, items, userId = "anonymous") {
  return mergeSync(type, items, workspace, userId);
}
export async function updateItem(type, id, workspace, fn, userId = "anonymous") {
  const item = await get(type, id, workspace, userId);
  if (!item) return null;
  const modified = fn({ ...item });
  return update(type, id, modified, workspace, userId);
}
export async function deleteItem(type, id, workspace = "default", userId = "anonymous") {
  return remove(type, id, workspace, userId);
}
