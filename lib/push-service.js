/**
 * Phase 37.3: Multi-platform push notification service.
 *
 * Supports FCM (Android/iOS via Firebase), APNS (direct iOS), Web Push
 * (browsers via VAPID), Email (SMTP fallback), and SMS (stub — wire up
 * Twilio/etc. externally).
 *
 * Data model (persisted via json-path-store):
 *   data/users/<userId>/push/subscriptions.json
 *     { subscriptions: [ { id, platform, token, metadata, createdAt } ] }
 *   data/users/<userId>/push/preferences.json
 *     { channels: {fcm, apns, web, email, sms}, topics: {...}, quietHours }
 *   data/push/topics/<topic>.json
 *     { subscribers: [ userId ] }
 *
 * Adapters are loaded lazily so this module is cheap to import in tests.
 */
import { join } from "path";
import { randomUUID } from "crypto";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const VALID_PLATFORMS = new Set(["fcm", "apns", "web", "email", "sms"]);

// Adapter registry — exposed so tests can replace with mocks.
const adapters = {
  fcm: null,
  apns: null,
  web: null,
  email: null,
  sms: null,
};

/**
 * Replace adapters for testing. Pass a partial map; only given keys are
 * updated. Call with `null` to reset an adapter back to the default.
 * Each adapter is an async function `(token, notification) => {ok, id?, error?}`.
 */
export function setAdapters(overrides) {
  for (const [key, value] of Object.entries(overrides || {})) {
    if (key in adapters) adapters[key] = value;
  }
}

async function getAdapter(platform) {
  if (adapters[platform]) return adapters[platform];
  if (platform === "fcm") {
    const mod = await import("./push-adapters/fcm.js");
    adapters.fcm = mod.sendFcm;
    return adapters.fcm;
  }
  if (platform === "apns") {
    const mod = await import("./push-adapters/apns.js");
    adapters.apns = mod.sendApns;
    return adapters.apns;
  }
  if (platform === "web") {
    const mod = await import("./push-adapters/web-push.js");
    adapters.web = mod.sendWebPush;
    return adapters.web;
  }
  if (platform === "email") {
    const mod = await import("./push-adapters/email.js");
    adapters.email = mod.sendEmailPush;
    return adapters.email;
  }
  if (platform === "sms") {
    // No built-in SMS adapter — return a stub that fails gracefully.
    adapters.sms = async () => ({ ok: false, error: "SMS adapter not configured" });
    return adapters.sms;
  }
  throw new Error(`Unknown platform: ${platform}`);
}

function sanitizeUserId(uid) {
  if (typeof uid !== "string" || !String(uid).trim()) return "anonymous";
  return String(uid).trim().slice(0, 100).replace(/[^a-zA-Z0-9._-]/g, "") || "anonymous";
}

function sanitizeTopic(topic) {
  if (typeof topic !== "string" || !String(topic).trim()) {
    throw new Error("topic must be a non-empty string");
  }
  const cleaned = String(topic).trim().slice(0, 80).replace(/[^a-zA-Z0-9._-]/g, "");
  if (!cleaned) throw new Error("topic contains no valid characters");
  return cleaned;
}

function subscriptionsPath(userId) {
  return join(getDataDir(), "users", sanitizeUserId(userId), "push", "subscriptions.json");
}

function preferencesPath(userId) {
  return join(getDataDir(), "users", sanitizeUserId(userId), "push", "preferences.json");
}

function topicPath(topic) {
  return join(getDataDir(), "push", "topics", `${sanitizeTopic(topic)}.json`);
}

function defaultPreferences() {
  return {
    channels: { fcm: true, apns: true, web: true, email: true, sms: false },
    topics: {},
    quietHours: null, // e.g. { start: "22:00", end: "08:00", timezoneOffsetMinutes: 0 }
  };
}

// ── Subscription CRUD ────────────────────────────────────────────────────────

/**
 * Register a push subscription for a user.
 * @param {string} userId
 * @param {object} subscription
 *   { platform: 'fcm'|'apns'|'web'|'email'|'sms', token, metadata? }
 */
export async function registerSubscription(userId, subscription) {
  if (!subscription || typeof subscription !== "object") {
    throw new Error("subscription object required");
  }
  const platform = subscription.platform;
  if (!VALID_PLATFORMS.has(platform)) {
    throw new Error(`platform must be one of: ${[...VALID_PLATFORMS].join(", ")}`);
  }
  // For web push the token is the full PushSubscription object (with endpoint/keys).
  if (!subscription.token) throw new Error("subscription.token is required");

  const id = randomUUID();
  const record = {
    id,
    platform,
    token: subscription.token,
    metadata: subscription.metadata || {},
    createdAt: new Date().toISOString(),
  };

  const path = subscriptionsPath(userId);
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { subscriptions: [] });
    const items = Array.isArray(data.subscriptions) ? [...data.subscriptions] : [];
    // Dedupe: replace any prior subscription with same platform + token fingerprint
    const tokenKey = typeof record.token === "string" ? record.token : JSON.stringify(record.token);
    const filtered = items.filter((s) => {
      const sKey = typeof s.token === "string" ? s.token : JSON.stringify(s.token);
      return !(s.platform === platform && sKey === tokenKey);
    });
    filtered.push(record);
    await writeJsonPath(path, { subscriptions: filtered });
  });
  return record;
}

export async function unregisterSubscription(subscriptionId, userId) {
  const path = subscriptionsPath(userId);
  return withPathLock(path, async () => {
    const data = await readJsonPath(path, { subscriptions: [] });
    const items = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    const next = items.filter((s) => s.id !== subscriptionId);
    const removed = items.length !== next.length;
    if (removed) await writeJsonPath(path, { subscriptions: next });
    return { removed };
  });
}

export async function listUserSubscriptions(userId) {
  const path = subscriptionsPath(userId);
  const data = await readJsonPath(path, { subscriptions: [] });
  return Array.isArray(data.subscriptions) ? data.subscriptions : [];
}

// ── Preferences ──────────────────────────────────────────────────────────────

export async function getNotificationPreferences(userId) {
  const path = preferencesPath(userId);
  const data = await readJsonPath(path, null);
  if (!data || typeof data !== "object" || !data.channels) {
    return defaultPreferences();
  }
  return { ...defaultPreferences(), ...data, channels: { ...defaultPreferences().channels, ...(data.channels || {}) } };
}

export async function setNotificationPreferences(userId, prefs) {
  if (!prefs || typeof prefs !== "object") {
    throw new Error("prefs object required");
  }
  const current = await getNotificationPreferences(userId);
  const merged = {
    channels: { ...current.channels, ...(prefs.channels || {}) },
    topics: { ...current.topics, ...(prefs.topics || {}) },
    quietHours: prefs.quietHours !== undefined ? prefs.quietHours : current.quietHours,
  };
  // Validate quiet hours shape if provided
  if (merged.quietHours && typeof merged.quietHours === "object") {
    const { start, end } = merged.quietHours;
    if (typeof start !== "string" || typeof end !== "string" ||
        !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) {
      throw new Error("quietHours must have HH:MM string start and end");
    }
  }
  const path = preferencesPath(userId);
  await withPathLock(path, async () => {
    await writeJsonPath(path, merged);
  });
  return merged;
}

/**
 * Return whether the given time falls inside the user's quiet hours.
 * Wraps around midnight when start > end.
 * @param {object} prefs
 * @param {Date} [now]
 */
export function isInQuietHours(prefs, now = new Date()) {
  if (!prefs || !prefs.quietHours || typeof prefs.quietHours !== "object") return false;
  const { start, end, timezoneOffsetMinutes } = prefs.quietHours;
  if (typeof start !== "string" || typeof end !== "string") return false;

  const offset = Number.isFinite(timezoneOffsetMinutes) ? timezoneOffsetMinutes : -now.getTimezoneOffset();
  const shifted = new Date(now.getTime() + (offset + now.getTimezoneOffset()) * 60_000);
  const minutes = shifted.getHours() * 60 + shifted.getMinutes();

  const [sH, sM] = start.split(":").map(Number);
  const [eH, eM] = end.split(":").map(Number);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;

  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return minutes >= startMin && minutes < endMin;
  }
  // Wrap-around (e.g. 22:00 → 08:00)
  return minutes >= startMin || minutes < endMin;
}

// ── Topics ───────────────────────────────────────────────────────────────────

export async function subscribeToTopic(userId, topic) {
  const t = sanitizeTopic(topic);
  const uid = sanitizeUserId(userId);
  const path = topicPath(t);
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { subscribers: [] });
    const subs = Array.isArray(data.subscribers) ? data.subscribers : [];
    if (!subs.includes(uid)) {
      subs.push(uid);
      await writeJsonPath(path, { subscribers: subs });
    }
  });
  return { topic: t, userId: uid };
}

export async function unsubscribeFromTopic(userId, topic) {
  const t = sanitizeTopic(topic);
  const uid = sanitizeUserId(userId);
  const path = topicPath(t);
  await withPathLock(path, async () => {
    const data = await readJsonPath(path, { subscribers: [] });
    const subs = Array.isArray(data.subscribers) ? data.subscribers : [];
    const next = subs.filter((s) => s !== uid);
    if (next.length !== subs.length) {
      await writeJsonPath(path, { subscribers: next });
    }
  });
  return { topic: t, userId: uid };
}

export async function listTopicSubscribers(topic) {
  const path = topicPath(topic);
  const data = await readJsonPath(path, { subscribers: [] });
  return Array.isArray(data.subscribers) ? data.subscribers : [];
}

export async function publishToTopic(topic, notification) {
  const subscribers = await listTopicSubscribers(topic);
  return sendBulkPush(subscribers, notification);
}

// ── Sending ──────────────────────────────────────────────────────────────────

/**
 * Send a notification to all of a user's registered subscriptions, filtered
 * by their notification preferences and quiet hours.
 *
 * @param {string} userId
 * @param {object} notification
 *   { title, body, icon?, badge?, data?, actions?, priority?, bypassQuietHours? }
 * @returns {Promise<{sent:number, failed:number, results:Array}>}
 */
export async function sendPush(userId, notification) {
  if (!notification || typeof notification !== "object") {
    throw new Error("notification object required");
  }
  if (!notification.title && !notification.body) {
    throw new Error("notification must have title or body");
  }

  const prefs = await getNotificationPreferences(userId);
  if (!notification.bypassQuietHours && isInQuietHours(prefs)) {
    return { sent: 0, failed: 0, skipped: true, reason: "quiet_hours", results: [] };
  }

  const subs = await listUserSubscriptions(userId);
  if (subs.length === 0) {
    return { sent: 0, failed: 0, results: [] };
  }

  const results = [];
  for (const sub of subs) {
    const channelEnabled = prefs.channels?.[sub.platform] !== false;
    if (!channelEnabled) {
      results.push({ subscriptionId: sub.id, platform: sub.platform, ok: false, skipped: true, reason: "channel_disabled" });
      continue;
    }
    try {
      const adapter = await getAdapter(sub.platform);
      const res = await adapter(sub.token, notification);
      results.push({ subscriptionId: sub.id, platform: sub.platform, ...res });
    } catch (err) {
      results.push({ subscriptionId: sub.id, platform: sub.platform, ok: false, error: err.message });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  return { sent, failed, results };
}

/**
 * Send the same notification to multiple users.
 * @param {string[]} userIds
 * @param {object} notification
 */
export async function sendBulkPush(userIds, notification) {
  const list = Array.isArray(userIds) ? userIds : [];
  const byUser = {};
  let sent = 0;
  let failed = 0;
  for (const uid of list) {
    try {
      const r = await sendPush(uid, notification);
      byUser[uid] = r;
      sent += r.sent || 0;
      failed += r.failed || 0;
    } catch (err) {
      byUser[uid] = { sent: 0, failed: 0, error: err.message, results: [] };
      failed += 1;
    }
  }
  return { sent, failed, users: byUser };
}

// ── Testing helpers ──────────────────────────────────────────────────────────

/**
 * Reset adapter registry (for tests).
 */
export function _resetAdapters() {
  adapters.fcm = null;
  adapters.apns = null;
  adapters.web = null;
  adapters.email = null;
  adapters.sms = null;
}
