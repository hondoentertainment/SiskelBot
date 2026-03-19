/**
 * Phase 10: Persistent backend storage for SiskelBot.
 * Phase 14: Scoped by userId + workspaceId: data/users/{userId}/workspaces/{workspaceId}/
 * Phase 29: Team workspaces (type: "personal" | "team"), members, roles.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { getWorkspacesForMember } from "./teams.js";
import { join, dirname } from "path";
import { sqliteKvLoad, sqliteKvSave, sqliteKvEnabled } from "./storage-sqlite-kv.js";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STORAGE_VERSION = 1;
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

function sanitizeUserId(uid) {
  if (typeof uid !== "string" || !String(uid).trim()) return "anonymous";
  const s = String(uid).trim().slice(0, 100);
  return USER_ID_PATTERN.test(s) ? s : "anonymous";
}

export function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  const s = String(ws).trim().slice(0, 50);
  return WORKSPACE_PATTERN.test(s) ? s : "default";
}

function getFilePath(type, userId, workspaceId) {
  const dir = getDataDir();
  const files = { context: "context.json", recipes: "recipes.json", conversations: "conversations.json" };
  const name = files[type];
  if (!name) throw new Error(`Unknown storage type: ${type}`);
  const uid = sanitizeUserId(userId);
  const ws = sanitizeWorkspace(workspaceId);
  return join(dir, "users", uid, "workspaces", ws, name);
}

function getLegacyFilePath(type) {
  const dir = getDataDir();
  const files = { context: "context.json", recipes: "recipes.json", conversations: "conversations.json" };
  const name = files[type];
  if (!name) throw new Error(`Unknown storage type: ${type}`);
  return join(dir, name);
}

function loadRaw(filePath) {
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

function saveRaw(filePath, data) {
  if (sqliteKvEnabled() && sqliteKvSave(filePath, data, getDataDir)) {
    return;
  }
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 0), "utf8");
}

async function withLock(filePath, fn) {
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

function migrateLegacyIfNeeded(type, userId, workspaceId) {
  const uid = sanitizeUserId(userId);
  const ws = sanitizeWorkspace(workspaceId);
  if (uid !== "anonymous" || ws !== "default") return;
  const legacyPath = getLegacyFilePath(type);
  const newPath = getFilePath(type, userId, workspaceId);
  if (!existsSync(legacyPath) || existsSync(newPath)) return;
  try {
    const data = loadRaw(legacyPath);
    if (Array.isArray(data.items) && data.items.length > 0) {
      saveRaw(newPath, data);
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

export function list(type, workspace = "default", userId = "anonymous") {
  migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = getFilePath(type, userId, workspace);
  const data = loadRaw(filePath);
  const items = Array.isArray(data.items) ? data.items : [];
  return items;
}

export function get(type, id, workspace = "default", userId = "anonymous") {
  const items = list(type, workspace, userId);
  return items.find((i) => String(i.id) === String(id)) || null;
}

export async function add(type, itemOrItems, workspace = "default", merge = false, userId = "anonymous") {
  migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = getFilePath(type, userId, workspace);
  const ws = sanitizeWorkspace(workspace);
  return withLock(filePath, () => {
    const data = loadRaw(filePath);
    let items = Array.isArray(data.items) ? data.items : [];
    const incoming = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];

    incoming.forEach((it) => {
      const item = { ...it, workspace: ws };
      if (!item.id) item.id = randomUUID();
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      const idx = items.findIndex((i) => String(i.id) === String(item.id));
      if (merge && idx >= 0) {
        items[idx] = { ...items[idx], ...item };
      } else if (idx < 0) {
        items.push(item);
      }
    });
    data._version = STORAGE_VERSION;
    data.items = items;
    saveRaw(filePath, data);
    return merge ? items : items[items.length - 1];
  });
}

export async function mergeSync(type, clientItems, workspace = "default", userId = "anonymous") {
  migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = getFilePath(type, userId, workspace);
  const ws = sanitizeWorkspace(workspace);
  return withLock(filePath, () => {
    const data = loadRaw(filePath);
    let items = Array.isArray(data.items) ? data.items : [];
    const incoming = Array.isArray(clientItems) ? clientItems : [];
    const byId = new Map(items.map((i) => [String(i.id), { ...i }]));
    incoming.forEach((it) => {
      const item = { ...it };
      if (!item.id) item.id = randomUUID();
      item.workspace = ws;
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      item.updatedAt = new Date().toISOString();
      byId.set(String(item.id), item);
    });
    items = Array.from(byId.values()).filter((i) => i.workspace === ws);
    data._version = STORAGE_VERSION;
    data.items = items;
    saveRaw(filePath, data);
    return items;
  });
}

export async function replace(type, newItems, workspace = "default", userId = "anonymous") {
  migrateLegacyIfNeeded(type, userId, workspace);
  const filePath = getFilePath(type, userId, workspace);
  const ws = sanitizeWorkspace(workspace);
  return withLock(filePath, () => {
    const normalized = (Array.isArray(newItems) ? newItems : []).map((it) => ({
      ...it,
      workspace: ws,
      createdAt: it.createdAt || new Date().toISOString(),
    }));
    const data = { _version: STORAGE_VERSION, items: normalized };
    saveRaw(filePath, data);
    return normalized;
  });
}

export async function update(type, id, updates, workspace = "default", userId = "anonymous") {
  const filePath = getFilePath(type, userId, workspace);
  const ws = sanitizeWorkspace(workspace);
  return withLock(filePath, () => {
    const data = loadRaw(filePath);
    const items = Array.isArray(data.items) ? data.items : [];
    const idx = items.findIndex((i) => String(i.id) === String(id));
    if (idx < 0) return null;
    items[idx] = { ...items[idx], ...updates, id: items[idx].id, updatedAt: new Date().toISOString() };
    data.items = items;
    saveRaw(filePath, data);
    return items[idx];
  });
}

export async function remove(type, id, workspace = "default", userId = "anonymous") {
  const filePath = getFilePath(type, userId, workspace);
  return withLock(filePath, () => {
    const data = loadRaw(filePath);
    const items = Array.isArray(data.items) ? data.items : [];
    const before = items.length;
    data.items = items.filter((i) => String(i.id) !== String(id));
    if (data.items.length === before) return false;
    saveRaw(filePath, data);
    return true;
  });
}

// --- Workspaces metadata ---
/**
 * Get a workspace by ID from owner's workspaces file (reads raw file to avoid recursion).
 * @param {string} ownerId
 * @param {string} workspaceId
 * @returns {object | null} Workspace object or null
 */
export function getWorkspaceById(ownerId, workspaceId) {
  const path = getWorkspacesMetaPath(ownerId);
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    const items = Array.isArray(data.items) ? data.items : [];
    return items.find((w) => String(w.id) === String(workspaceId)) || null;
  } catch (e) {
    return null;
  }
}

export function listWorkspaces(userId = "anonymous") {
  const uid = sanitizeUserId(userId);
  const defaultWs = { id: "default", name: "Default", userId: uid, createdAt: new Date(0).toISOString(), type: "personal" };
  const path = getWorkspacesMetaPath(userId);
  let ownItems = [];
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw);
      const items = Array.isArray(data.items) ? data.items : [];
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
    const memberOf = getWorkspacesForMember(uid);
    for (const { workspaceId, ownerId } of memberOf) {
      if (ownItems.some((w) => String(w.id) === String(workspaceId))) continue;
      const ws = getWorkspaceById(ownerId, workspaceId);
      if (ws) ownItems.push({ ...ws, type: ws.type || "team" });
    }
  } catch (e) {
    console.warn("[storage] Team workspaces merge failed", e.message);
  }
  return ownItems;
}

export async function createWorkspace(userId, name, type = "personal") {
  const uid = sanitizeUserId(userId);
  const safeName = typeof name === "string" ? name.trim().slice(0, 100) : "Workspace";
  const wsType = type === "team" ? "team" : "personal";
  const id = randomUUID();
  const path = getWorkspacesMetaPath(userId);
  return withLock(path, async () => {
    const items = listWorkspaces(userId).filter((w) => w.id !== "default");
    const ws = { id, name: safeName || "Workspace", userId: uid, createdAt: new Date().toISOString(), type: wsType };
    items.push(ws);
    const data = { _version: 1, items: [{ id: "default", name: "Default", userId: uid, createdAt: new Date(0).toISOString(), type: "personal" }, ...items] };
    ensureDir(dirname(path));
    writeFileSync(path, JSON.stringify(data, null, 0), "utf8");
    if (wsType === "team") {
      const { registerWorkspaceMembers } = await import("./teams.js");
      registerWorkspaceMembers(id, uid, [{ userId: uid, role: "admin" }]);
    }
    return ws;
  });
}

// --- Server API compatibility ---
export function listItems(type, workspace = "default", userId = "anonymous") {
  return list(type, workspace, userId);
}
export function getItem(type, id, workspace = "default", userId = "anonymous") {
  return get(type, id, workspace, userId);
}
export async function mergeItems(type, workspace, items, userId = "anonymous") {
  return mergeSync(type, items, workspace, userId);
}
export async function updateItem(type, id, workspace, fn, userId = "anonymous") {
  const item = get(type, id, workspace, userId);
  if (!item) return null;
  const modified = fn({ ...item });
  return update(type, id, modified, workspace, userId);
}
export async function deleteItem(type, id, workspace = "default", userId = "anonymous") {
  return remove(type, id, workspace, userId);
}
