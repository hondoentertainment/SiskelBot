/**
 * Phase 37.2: Push notification helpers.
 *
 * FCM (Firebase Cloud Messaging) for Android and APNS (Apple Push
 * Notification Service) for iOS. Device tokens are stored per user via the
 * shared JSON/SQLite/Postgres storage backend.
 *
 * Environment variables:
 *   FCM_SERVER_KEY   - FCM legacy server key (required for sendFCM)
 *   FCM_API_URL      - override for FCM endpoint (tests)
 *   APNS_AUTH_TOKEN  - APNS JWT bearer token (required for sendAPNS)
 *   APNS_API_URL     - override for APNS endpoint (tests)
 *   APNS_TOPIC       - APNS topic (bundle id)
 *
 * Test hooks (never used in production):
 *   setPushTransport({ fcm, apns }) - inject mocked fetch functions.
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

function devicesPath(userId) {
  const uid = String(userId || "anonymous").replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 80) || "anonymous";
  return join(getDataDir(), "users", uid, "push-devices.json");
}

async function loadDevices(userId) {
  const data = await readJsonPath(devicesPath(userId), { _version: 1, items: [] });
  return Array.isArray(data?.items) ? data.items : [];
}

async function saveDevices(userId, items) {
  await writeJsonPath(devicesPath(userId), { _version: 1, items });
}

/**
 * @typedef {Object} PushPayload
 * @property {string} title
 * @property {string} body
 * @property {object} [data]
 */

let _transport = {
  fcm: null,
  apns: null,
};

/**
 * Override the HTTP transport used for FCM/APNS requests. Tests inject
 * mocks here so they don't hit the network.
 * @param {{ fcm?: Function|null, apns?: Function|null }} overrides
 */
export function setPushTransport(overrides = {}) {
  if ("fcm" in overrides) _transport.fcm = overrides.fcm || null;
  if ("apns" in overrides) _transport.apns = overrides.apns || null;
}

/**
 * @returns {{ fcm: boolean, apns: boolean, configured: boolean }}
 */
export function isPushConfigured() {
  const fcm = Boolean(process.env.FCM_SERVER_KEY || _transport.fcm);
  const apns = Boolean(process.env.APNS_AUTH_TOKEN || _transport.apns);
  return { fcm, apns, configured: fcm || apns };
}

function normalizePayload(payload) {
  const title = (payload && typeof payload.title === "string") ? payload.title : "";
  const body = (payload && typeof payload.body === "string") ? payload.body : "";
  const data = (payload && payload.data && typeof payload.data === "object") ? payload.data : {};
  return { title, body, data };
}

/**
 * Send a push notification to an Android device via FCM.
 * @param {string} token - FCM registration token
 * @param {PushPayload} payload
 * @returns {Promise<{ok: boolean, status: number, id?: string, error?: string}>}
 */
export async function sendFCM(token, payload) {
  if (!token || typeof token !== "string") throw new Error("FCM token is required");
  const { title, body, data } = normalizePayload(payload);
  const serverKey = process.env.FCM_SERVER_KEY || "";
  const url = process.env.FCM_API_URL || "https://fcm.googleapis.com/fcm/send";
  const reqBody = {
    to: token,
    notification: { title, body },
    data,
  };

  const fetcher = _transport.fcm || globalThis.fetch;
  if (!_transport.fcm && !serverKey) {
    throw new Error("FCM not configured (set FCM_SERVER_KEY)");
  }
  if (typeof fetcher !== "function") {
    throw new Error("FCM transport unavailable (no fetch)");
  }
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `key=${serverKey}`,
    },
    body: JSON.stringify(reqBody),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  if (!res.ok) {
    return { ok: false, status: res.status, error: json?.error || `FCM HTTP ${res.status}` };
  }
  return {
    ok: true,
    status: res.status,
    id: json?.message_id || json?.multicast_id || json?.results?.[0]?.message_id || null,
  };
}

/**
 * Send a push notification to an iOS device via APNS.
 * @param {string} token - APNS device token (hex string)
 * @param {PushPayload} payload
 * @returns {Promise<{ok: boolean, status: number, id?: string, error?: string}>}
 */
export async function sendAPNS(token, payload) {
  if (!token || typeof token !== "string") throw new Error("APNS token is required");
  const { title, body, data } = normalizePayload(payload);
  const authToken = process.env.APNS_AUTH_TOKEN || "";
  const topic = process.env.APNS_TOPIC || "com.siskelbot.app";
  const baseUrl = process.env.APNS_API_URL || "https://api.push.apple.com";
  const url = `${baseUrl}/3/device/${encodeURIComponent(token)}`;
  const reqBody = {
    aps: {
      alert: { title, body },
      sound: "default",
    },
    data,
  };

  const fetcher = _transport.apns || globalThis.fetch;
  if (!_transport.apns && !authToken) {
    throw new Error("APNS not configured (set APNS_AUTH_TOKEN)");
  }
  if (typeof fetcher !== "function") {
    throw new Error("APNS transport unavailable (no fetch)");
  }
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `bearer ${authToken}`,
      "apns-topic": topic,
      "apns-push-type": "alert",
    },
    body: JSON.stringify(reqBody),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { json = null; }
  const apnsId = (res.headers?.get?.("apns-id")) || json?.["apns-id"] || null;
  if (!res.ok) {
    return { ok: false, status: res.status, error: json?.reason || `APNS HTTP ${res.status}` };
  }
  return { ok: true, status: res.status, id: apnsId };
}

function normalizePlatform(p) {
  const v = String(p || "").toLowerCase();
  if (v === "ios" || v === "apns" || v === "apple") return "ios";
  if (v === "android" || v === "fcm" || v === "gcm") return "android";
  return null;
}

/**
 * Register (or update) a device token for a user.
 * @param {string} userId
 * @param {string} platform  "ios" | "android"
 * @param {string} token
 * @returns {Promise<object>}
 */
export async function registerDeviceToken(userId, platform, token) {
  if (!userId || typeof userId !== "string") throw new Error("userId is required");
  const plat = normalizePlatform(platform);
  if (!plat) throw new Error("platform must be ios or android");
  if (!token || typeof token !== "string") throw new Error("token is required");

  return withPathLock(devicesPath(userId), async () => {
    const items = await loadDevices(userId);
    const prior = items.find((d) => d.token === token);
    if (prior) {
      prior.platform = plat;
      prior.updatedAt = new Date().toISOString();
      await saveDevices(userId, items);
      return { ...prior };
    }
    const record = {
      id: randomUUID(),
      userId,
      platform: plat,
      token,
      createdAt: new Date().toISOString(),
    };
    items.push(record);
    await saveDevices(userId, items);
    return { ...record };
  });
}

/**
 * Remove a device token for a specific user.
 * @param {string} userId
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export async function unregisterDeviceTokenForUser(userId, token) {
  if (!userId || !token) return false;
  return withPathLock(devicesPath(userId), async () => {
    const items = await loadDevices(userId);
    const idx = items.findIndex((d) => d.token === token);
    if (idx < 0) return false;
    items.splice(idx, 1);
    await saveDevices(userId, items);
    return true;
  });
}

/**
 * Remove a device token without knowing its owner. Provided for API
 * symmetry with the task spec; in practice routes call the variant that
 * takes a userId so they do not have to scan every user directory.
 * @param {string} token
 * @param {string} [userId] - optional hint; when omitted, no-op returns false
 */
export async function unregisterDeviceToken(token, userId = null) {
  if (userId) return unregisterDeviceTokenForUser(userId, token);
  return false;
}

/**
 * List all registered device tokens for a user.
 * @param {string} userId
 * @returns {Promise<Array<{id:string,platform:string,token:string}>>}
 */
export async function getDeviceTokens(userId) {
  if (!userId || typeof userId !== "string") return [];
  const items = await loadDevices(userId);
  return items.map((d) => ({
    id: d.id,
    platform: d.platform,
    token: d.token,
    createdAt: d.createdAt,
  }));
}

/**
 * Send a notification to every registered device for a user.
 * @param {string} userId
 * @param {string} title
 * @param {string} body
 * @param {object} [data]
 * @returns {Promise<{sent:number, failed:number, results:Array}>}
 */
export async function notifyUser(userId, title, body, data = {}) {
  const devices = await getDeviceTokens(userId);
  if (!devices.length) return { sent: 0, failed: 0, results: [] };
  const payload = { title, body, data };
  const results = [];
  let sent = 0;
  let failed = 0;
  for (const d of devices) {
    try {
      const res = d.platform === "ios"
        ? await sendAPNS(d.token, payload)
        : await sendFCM(d.token, payload);
      if (res.ok) sent++; else failed++;
      results.push({ platform: d.platform, token: d.token, ...res });
    } catch (err) {
      failed++;
      results.push({ platform: d.platform, token: d.token, ok: false, error: err.message });
    }
  }
  return { sent, failed, results };
}
