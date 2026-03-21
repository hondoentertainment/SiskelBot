/**
 * Phase 27: In-App Notification Center
 * Phase 33: Broadcasts to WebSocket when notification created (real-time sync).
 * Phase 68: Durable store via json-path-store (Postgres / SQLite / file).
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { broadcastNotification } from "./realtime.js";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_NOTIFICATIONS = 100;
const EVENT_TO_TYPE = {
  recipe_executed: "recipe_completed",
  schedule_completed: "schedule_completed",
  plan_created: "plan_created",
  message_sent: "generic",
};
const INCLUDE_MESSAGE_SENT = process.env.NOTIFICATIONS_INCLUDE_MESSAGE_SENT === "1";

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

/**
 * Add a notification from a webhook event. Called by webhooks.emitEvent.
 */
export async function pushFromEvent(eventName, payload = {}, opts = {}) {
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

  const path = getNotificationsPath(userId, workspaceId);
  try {
    const n = await withPathLock(path, async () => {
      const data = await readJsonPath(path, { items: [] });
      const items = Array.isArray(data.items) ? [...data.items] : [];
      items.push(notification);
      const trimmed = items.slice(-MAX_NOTIFICATIONS);
      await writeJsonPath(path, { items: trimmed });
      return notification;
    });
    try {
      broadcastNotification(userId, workspaceId, n);
    } catch (_) {}
  } catch (e) {
    console.warn("[notifications] pushFromEvent error:", e.message);
  }
}

/**
 * List notifications for a workspace (newest first).
 */
export async function list(workspaceId = "default", userId = "anonymous") {
  const path = getNotificationsPath(userId, workspaceId);
  const data = await readJsonPath(path, { items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  return [...items].reverse();
}

/**
 * Mark a notification as read.
 */
export async function markRead(id, workspaceId = "default", userId = "anonymous") {
  const path = getNotificationsPath(userId, workspaceId);
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { items: [] });
    const items = Array.isArray(data.items) ? [...data.items] : [];
    const idx = items.findIndex((n) => String(n.id) === String(id));
    if (idx < 0) return false;
    items[idx] = { ...items[idx], read: true };
    await writeJsonPath(path, { items });
    return true;
  });
}

/**
 * Mark all notifications as read in a workspace.
 */
export async function markAllRead(workspaceId = "default", userId = "anonymous") {
  const path = getNotificationsPath(userId, workspaceId);
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { items: [] });
    const items = Array.isArray(data.items) ? [...data.items] : [];
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      if (!items[i].read) {
        items[i] = { ...items[i], read: true };
        changed = true;
      }
    }
    if (changed) await writeJsonPath(path, { items });
    return true;
  });
}
