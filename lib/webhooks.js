/**
 * Phase 22: Event Webhooks & Notifications
 * Store webhook subscriptions, emit events to registered URLs with fire-and-forget + retry.
 * Phase 27: Also pushes to in-app notification center when emitEvent fires.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { pushFromEvent as pushNotification } from "./notifications.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHmac } from "crypto";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const RETRY_DELAYS_MS = [1000, 5000];
const FETCH_TIMEOUT_MS = 15000;

const locks = new Map();
const urlTimestamps = new Map();

function getDataDir() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getWebhooksPath() {
  return join(getDataDir(), "webhooks.json");
}

function loadWebhooks() {
  const path = getWebhooksPath();
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw);
      return data && typeof data === "object" ? data : {};
    }
  } catch (e) {
    console.warn("[webhooks] Failed to load:", e.message);
  }
  return {};
}

function saveWebhooks(data) {
  const path = getWebhooksPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 0), "utf8");
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

function signPayload(body, secret) {
  if (!secret || typeof secret !== "string") return null;
  const hmac = createHmac("sha256", secret.trim());
  hmac.update(typeof body === "string" ? body : JSON.stringify(body));
  return hmac.digest("hex");
}

async function deliverOne(url, payload, secret) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  const sig = signPayload(body, secret);
  if (sig) headers["X-Webhook-Signature"] = `sha256=${sig}`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) return;
      const text = await res.text().catch(() => "");
      console.warn(`[webhooks] ${url} HTTP ${res.status} attempt ${attempt + 1}: ${text?.slice(0, 200)}`);
    } catch (err) {
      console.warn(`[webhooks] ${url} attempt ${attempt + 1}:`, err.message);
    }
    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

/**
 * Emit an event to all webhooks subscribed to it. Fire-and-forget, non-blocking.
 * @param {string} eventName - message_sent | plan_created | recipe_executed | schedule_completed
 * @param {object} payload - Event-specific data (merged into payload.data)
 * @param {object} opts - { workspaceId, userId? }
 */
export function emitEvent(eventName, payload = {}, opts = {}) {
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

  const data = loadWebhooks();
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
      deliverOne(url, envelope, sub.secret).catch(() => {});
    });
  }

  // Phase 27: Push to in-app notification center
  try {
    pushNotification(eventName, payload, { workspaceId, userId });
  } catch (e) {
    console.warn("[webhooks] notification push failed:", e.message);
  }
}

// --- CRUD for webhook subscriptions ---

/**
 * List webhooks for a workspace.
 */
export function listWebhooks(workspaceId = "default") {
  const data = loadWebhooks();
  const ws = String(workspaceId || "default").trim().slice(0, 50) || "default";
  const list = Array.isArray(data[ws]) ? data[ws] : [];
  return list.map((w) => ({ ...w, secret: undefined })); // never return secret to client
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

  return withLock(getWebhooksPath(), () => {
    const data = loadWebhooks();
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
    saveWebhooks(data);
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
  return withLock(getWebhooksPath(), () => {
    const data = loadWebhooks();
    const list = Array.isArray(data[ws]) ? data[ws] : [];
    const before = list.length;
    const filtered = list.filter((w) => String(w.id) !== String(id));
    if (filtered.length >= before) return false;
    data[ws] = filtered;
    saveWebhooks(data);
    return true;
  });
}
