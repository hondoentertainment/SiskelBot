/**
 * Phase 27: In-App Notification Center
 * Phase 33: Broadcasts to WebSocket when notification created (real-time sync).
 * Server-side notification store. Scoped by workspace: data/users/{userId}/workspaces/{workspaceId}/notifications.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { broadcastNotification } from "./realtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MAX_NOTIFICATIONS = 100;
const EVENT_TO_TYPE = {
  recipe_executed: "recipe_completed",
  schedule_completed: "schedule_completed",
  plan_created: "plan_created",
  message_sent: "generic",
};
const INCLUDE_MESSAGE_SENT = process.env.NOTIFICATIONS_INCLUDE_MESSAGE_SENT === "1";
const locks = new Map();

function getDataDir() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeUserId(uid) {
  if (typeof uid !== "string" || !String(uid).trim()) return "anonymous";
  return String(uid).trim().slice(0, 100).replace(/[^a-zA-Z0-9._-]/g, "") || "anonymous";
}

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

function getNotificationsPath(userId, workspaceId) {
  const dir = getDataDir();
  const uid = sanitizeUserId(userId);
  const ws = sanitizeWorkspace(workspaceId);
  return join(dir, "users", uid, "workspaces", ws, "notifications.json");
}

function loadNotifications(userId, workspaceId) {
  const path = getNotificationsPath(userId, workspaceId);
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data.items) ? data.items : [];
    }
  } catch (e) {
    console.warn("[notifications] Failed to load:", e.message);
  }
  return [];
}

function saveNotifications(userId, workspaceId, items) {
  const path = getNotificationsPath(userId, workspaceId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const trimmed = items.slice(-MAX_NOTIFICATIONS);
  writeFileSync(path, JSON.stringify({ items: trimmed }, null, 0), "utf8");
}

async function withLock(key, fn) {
  let p = locks.get(key);
  if (!p) p = Promise.resolve();
  const next = p.then(() => fn()).catch((e) => {
    throw e;
  });
  locks.set(key, next);
  return next;
}

/**
 * Add a notification from a webhook event. Called by webhooks.emitEvent.
 */
export function pushFromEvent(eventName, payload = {}, opts = {}) {
  if (eventName === "message_sent" && !INCLUDE_MESSAGE_SENT) return;
  const type = EVENT_TO_TYPE[eventName] || "generic";
  const workspaceId = opts.workspaceId || "default";
  const userId = opts.userId ?? "anonymous";

  let title = "";
  let body = "";
  switch (eventName) {
    case "recipe_executed":
      title = "Recipe completed";
      body = payload.recipeName || payload.step?.action || "Recipe step executed";
      break;
    case "schedule_completed":
      title = "Schedule completed";
      body = payload.recipeName || `Recipe ${payload.recipeId || ""} ran successfully`;
      break;
    case "plan_created":
      title = "Plan created";
      body = payload.plan?.name || "Task plan created";
      break;
    case "message_sent":
      title = "Message sent";
      body = payload.content?.slice(0, 100) || "";
      break;
    default:
      title = "Event";
      body = JSON.stringify(payload).slice(0, 200);
  }

  const id = randomUUID();
  const notification = {
    id,
    type,
    title,
    body,
    createdAt: new Date().toISOString(),
    read: false,
  };

  const key = `${userId}:${workspaceId}`;
  withLock(key, () => {
    const items = loadNotifications(userId, workspaceId);
    items.push(notification);
    saveNotifications(userId, workspaceId, items);
    return notification;
  })
    .then((n) => {
      try {
        broadcastNotification(userId, workspaceId, n);
      } catch (_) {}
    })
    .catch((e) => console.warn("[notifications] pushFromEvent error:", e.message));
}

/**
 * List notifications for a workspace (newest first).
 */
export function list(workspaceId = "default", userId = "anonymous") {
  const items = loadNotifications(userId, workspaceId);
  return [...items].reverse();
}

/**
 * Mark a notification as read.
 */
export async function markRead(id, workspaceId = "default", userId = "anonymous") {
  const key = `${userId}:${workspaceId}`;
  return withLock(key, () => {
    const items = loadNotifications(userId, workspaceId);
    const idx = items.findIndex((n) => String(n.id) === String(id));
    if (idx < 0) return false;
    items[idx] = { ...items[idx], read: true };
    saveNotifications(userId, workspaceId, items);
    return true;
  });
}

/**
 * Mark all notifications as read in a workspace.
 */
export async function markAllRead(workspaceId = "default", userId = "anonymous") {
  const key = `${userId}:${workspaceId}`;
  return withLock(key, () => {
    const items = loadNotifications(userId, workspaceId);
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      if (!items[i].read) {
        items[i] = { ...items[i], read: true };
        changed = true;
      }
    }
    if (changed) saveNotifications(userId, workspaceId, items);
    return true;
  });
}
