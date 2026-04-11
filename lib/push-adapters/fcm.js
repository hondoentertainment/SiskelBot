/**
 * Phase 37.3: Firebase Cloud Messaging adapter.
 *
 * Uses the FCM HTTP v1 REST API directly (no SDK). Supports two auth modes:
 *   1. Legacy server key via FCM_SERVER_KEY (endpoint: /fcm/send)
 *   2. Service-account OAuth2 via FCM_SERVICE_ACCOUNT (JSON string or path),
 *      targeting /v1/projects/{project_id}/messages:send
 *
 * Both Android and iOS device tokens route through FCM.
 */
import { createSign } from "crypto";
import { readFileSync, existsSync } from "fs";

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || "";
const FCM_LEGACY_URL = "https://fcm.googleapis.com/fcm/send";
const FCM_V1_URL_TPL = "https://fcm.googleapis.com/v1/projects/{project}/messages:send";

let _serviceAccount = null;
let _tokenCache = null;

function loadServiceAccount() {
  if (_serviceAccount !== null) return _serviceAccount;
  const raw = process.env.FCM_SERVICE_ACCOUNT || "";
  if (!raw) {
    _serviceAccount = null;
    return null;
  }
  try {
    if (raw.trim().startsWith("{")) {
      _serviceAccount = JSON.parse(raw);
    } else if (existsSync(raw)) {
      _serviceAccount = JSON.parse(readFileSync(raw, "utf8"));
    } else {
      _serviceAccount = null;
    }
  } catch {
    _serviceAccount = null;
  }
  return _serviceAccount;
}

export function isFcmConfigured() {
  return Boolean(FCM_SERVER_KEY) || Boolean(loadServiceAccount());
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getOAuthAccessToken() {
  const sa = loadServiceAccount();
  if (!sa || !sa.client_email || !sa.private_key) return null;

  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(sa.private_key));
  const jwt = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    throw new Error(`FCM OAuth failed: ${resp.status}`);
  }
  const json = await resp.json();
  _tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
  };
  return _tokenCache.token;
}

/**
 * Send a notification via FCM.
 * @param {string} token - device registration token
 * @param {object} notification - { title, body, icon?, badge?, data?, priority? }
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
export async function sendFcm(token, notification) {
  if (!token) return { ok: false, error: "token required" };
  if (!isFcmConfigured()) {
    return { ok: false, error: "FCM not configured" };
  }

  const sa = loadServiceAccount();
  if (sa && sa.project_id) {
    try {
      const accessToken = await getOAuthAccessToken();
      const url = FCM_V1_URL_TPL.replace("{project}", sa.project_id);
      const body = {
        message: {
          token,
          notification: {
            title: notification.title || "",
            body: notification.body || "",
          },
          data: notification.data ? Object.fromEntries(
            Object.entries(notification.data).map(([k, v]) => [k, String(v)])
          ) : undefined,
          android: {
            priority: notification.priority === "high" ? "HIGH" : "NORMAL",
          },
        },
      };
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { ok: false, error: `FCM v1 ${resp.status}: ${text.slice(0, 200)}` };
      }
      const json = await resp.json().catch(() => ({}));
      return { ok: true, id: json.name || undefined };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Legacy server key
  try {
    const body = {
      to: token,
      notification: {
        title: notification.title || "",
        body: notification.body || "",
        icon: notification.icon,
        badge: notification.badge,
      },
      data: notification.data || {},
      priority: notification.priority === "high" ? "high" : "normal",
    };
    const resp = await fetch(FCM_LEGACY_URL, {
      method: "POST",
      headers: {
        Authorization: `key=${FCM_SERVER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `FCM legacy ${resp.status}: ${text.slice(0, 200)}` };
    }
    const json = await resp.json().catch(() => ({}));
    if (json.failure && json.failure > 0) {
      return { ok: false, error: JSON.stringify(json.results || json) };
    }
    return { ok: true, id: json.multicast_id ? String(json.multicast_id) : undefined };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Reset module caches (for tests).
 */
export function _resetFcmCache() {
  _serviceAccount = null;
  _tokenCache = null;
}
