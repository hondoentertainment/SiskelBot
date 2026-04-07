/**
 * Phase 22: Event Webhooks & Notifications
 * Phase 27: Also pushes to in-app notification center when emitEvent fires.
 * Phase 68: Durable store via json-path-store (Postgres / SQLite / file).
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { pushFromEvent as pushNotification } from "./notifications.js";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { isEmailConfigured, sendEmail } from "./email-notifications.js";
import { notifySlack, isSlackConfigured } from "./slack-bot.js";
import { notifyDiscord, isDiscordConfigured } from "./discord-bot.js";
import { deliverWebhook } from "./webhook-delivery.js";

const ALLOWED_EVENTS = [
  "message_sent",
  "plan_created",
  "recipe_executed",
  "schedule_completed",
  "swarm_started",
  "swarm_specialist_completed",
  "swarm_completed",
];
const RATE_LIMIT_PER_MIN = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ALLOW_WEBHOOK_LOCALHOST = process.env.ALLOW_WEBHOOK_LOCALHOST === "1";
const urlTimestamps = new Map();

function getWebhooksPath() {
  return join(getDataDir(), "webhooks.json");
}

/**
 * Validate webhook URL: HTTPS only, no localhost/private IP unless ALLOW_WEBHOOK_LOCALHOST=1.
 */
export function validateWebhookUrl(url) {
  if (typeof url !== "string" || !url.trim()) return { valid: false, reason: "URL required" };
  const u = url.trim();
  const allowLocalhost = ALLOW_WEBHOOK_LOCALHOST;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname || "";
    const isPrivate =
      /^localhost$/i.test(host) ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
      /^192\.168\./.test(host);
    if (isPrivate && !allowLocalhost) {
      return { valid: false, reason: "localhost and private IPs not allowed (set ALLOW_WEBHOOK_LOCALHOST=1 for dev)" };
    }
    if (!u.startsWith("https://")) {
      if (allowLocalhost && isPrivate && u.startsWith("http://")) {
        // Allow http for localhost when ALLOW_WEBHOOK_LOCALHOST=1
      } else {
        return { valid: false, reason: "URL must be HTTPS" };
      }
    }
    return { valid: true };
  } catch (_) {
    return { valid: false, reason: "Invalid URL" };
  }
}

function checkRateLimit(url) {
  const key = String(url).trim().toLowerCase();
  const now = Date.now();
  let ts = urlTimestamps.get(key) || [];
  ts = ts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (ts.length >= RATE_LIMIT_PER_MIN) return false;
  ts.push(now);
  urlTimestamps.set(key, ts);
  return true;
}

/**
 * Emit an event to all webhooks subscribed to it. Async (loads durable webhook list).
 */
export async function emitEvent(eventName, payload = {}, opts = {}) {
  if (!ALLOWED_EVENTS.includes(eventName)) {
    console.warn("[webhooks] Unknown event:", eventName);
    return;
  }
  const workspaceId = opts.workspaceId || "default";
  const userId = opts.userId;

  const envelope = {
    event: eventName,
    timestamp: new Date().toISOString(),
    workspaceId,
    userId: userId ?? undefined,
    data: payload && typeof payload === "object" ? payload : {},
  };

  const data = await readJsonPath(getWebhooksPath(), {});
  const list = Array.isArray(data[workspaceId]) ? data[workspaceId] : [];
  const subs = list.filter((w) => Array.isArray(w.events) && w.events.includes(eventName));

  for (const sub of subs) {
    const url = sub.url?.trim();
    if (!url) continue;
    if (!checkRateLimit(url)) {
      console.warn(`[webhooks] Rate limit exceeded for ${url}`);
      continue;
    }
    setImmediate(() => {
      deliverWebhook(url, envelope, { secret: sub.secret }).catch(() => {});
    });
  }

  try {
    await pushNotification(eventName, payload, { workspaceId, userId });
  } catch (e) {
    console.warn("[webhooks] notification push failed:", e.message);
  }

  // Email notification: send to subscribers with action=email
  if (isEmailConfigured()) {
    const emailSubs = list.filter(
      (w) => w.action === "email" && w.email && Array.isArray(w.events) && w.events.includes(eventName),
    );
    for (const sub of emailSubs) {
      setImmediate(() => {
        const subject = `[SiskelBot] ${eventName} - ${workspaceId}`;
        const body = JSON.stringify(envelope, null, 2);
        sendEmail(sub.email, subject, body).catch((err) => {
          console.warn("[webhooks] email notification failed:", err.message);
        });
      });
    }
  }

  // Slack notification
  if (isSlackConfigured()) {
    setImmediate(() => {
      notifySlack(eventName, envelope.data, { workspaceId }).catch((err) => {
        console.warn("[webhooks] Slack notification failed:", err.message);
      });
    });
  }

  // Discord notification
  if (isDiscordConfigured()) {
    setImmediate(() => {
      notifyDiscord(eventName, envelope.data, { workspaceId }).catch((err) => {
        console.warn("[webhooks] Discord notification failed:", err.message);
      });
    });
  }
}

/**
 * List webhooks for a workspace.
 */
export async function listWebhooks(workspaceId = "default") {
  const data = await readJsonPath(getWebhooksPath(), {});
  const ws = String(workspaceId || "default").trim().slice(0, 50) || "default";
  const list = Array.isArray(data[ws]) ? data[ws] : [];
  return list.map((w) => ({ ...w, secret: undefined }));
}

/**
 * Add a webhook subscription.
 */
export async function addWebhook({ url, events, secret }, workspaceId = "default") {
  const ws = String(workspaceId || "default").trim().slice(0, 50) || "default";
  const v = validateWebhookUrl(url);
  if (!v.valid) throw new Error(v.reason);
  const ev = Array.isArray(events) ? events.filter((e) => ALLOWED_EVENTS.includes(e)) : [];
  if (ev.length === 0) throw new Error("At least one event required");

  const path = getWebhooksPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, {});
    const list = Array.isArray(data[ws]) ? [...data[ws]] : [];
    const id = randomUUID();
    const entry = {
      id,
      url: url.trim(),
      events: ev,
      secret: typeof secret === "string" && secret.trim() ? secret.trim() : undefined,
      workspaceId: ws,
      createdAt: new Date().toISOString(),
    };
    list.push(entry);
    data[ws] = list;
    await writeJsonPath(path, data);
    const out = { ...entry };
    delete out.secret;
    return out;
  });
}

/**
 * Remove a webhook by id.
 */
export async function removeWebhook(id, workspaceId = "default") {
  const ws = String(workspaceId || "default").trim().slice(0, 50) || "default";
  const path = getWebhooksPath();
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, {});
    const list = Array.isArray(data[ws]) ? data[ws] : [];
    const before = list.length;
    const filtered = list.filter((w) => String(w.id) !== String(id));
    if (filtered.length >= before) return false;
    data[ws] = filtered;
    await writeJsonPath(path, data);
    return true;
  });
}
