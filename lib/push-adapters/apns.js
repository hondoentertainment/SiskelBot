/**
 * Phase 37.3: Apple Push Notification Service (APNS) adapter.
 *
 * Uses the APNS HTTP/2 Provider API with JWT authentication (p8 key).
 * The `@fastify/http2-client` / `node:http2` module is dynamically imported
 * to avoid pulling a heavyweight dep into the default load path.
 *
 * Configuration:
 *   APNS_KEY_ID       - Key ID from Apple Developer portal
 *   APNS_TEAM_ID      - Team ID from Apple Developer portal
 *   APNS_BUNDLE_ID    - App bundle id (default topic)
 *   APNS_KEY_PATH     - Path to a .p8 private key file
 *   APNS_KEY          - OR the key contents as an env var
 *   APNS_PRODUCTION   - "1" to target api.push.apple.com, else sandbox
 */
import { createSign } from "crypto";
import { readFileSync, existsSync } from "fs";

const APNS_KEY_ID = process.env.APNS_KEY_ID || "";
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || "";
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || "";
const APNS_KEY_PATH = process.env.APNS_KEY_PATH || "";
const APNS_KEY_INLINE = process.env.APNS_KEY || "";
const APNS_PRODUCTION = process.env.APNS_PRODUCTION === "1";

const APNS_HOST = APNS_PRODUCTION ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";

let _keyContents = null;
let _tokenCache = null;
let _http2Module = null;

export function isApnsConfigured() {
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_BUNDLE_ID) return false;
  if (!APNS_KEY_PATH && !APNS_KEY_INLINE) return false;
  return true;
}

function loadKey() {
  if (_keyContents) return _keyContents;
  if (APNS_KEY_INLINE) {
    _keyContents = APNS_KEY_INLINE.replace(/\\n/g, "\n");
    return _keyContents;
  }
  if (APNS_KEY_PATH && existsSync(APNS_KEY_PATH)) {
    _keyContents = readFileSync(APNS_KEY_PATH, "utf8");
    return _keyContents;
  }
  return null;
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the APNS provider JWT. Valid for ~55 minutes.
 */
function buildProviderJwt() {
  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60_000) {
    return _tokenCache.token;
  }
  const key = loadKey();
  if (!key) throw new Error("APNS key not available");

  const header = { alg: "ES256", kid: APNS_KEY_ID, typ: "JWT" };
  const claims = { iss: APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const signer = createSign("SHA256");
  signer.update(unsigned);
  signer.end();
  // ES256 signatures from Node come in DER format; APNS wants raw r||s (64 bytes).
  const der = signer.sign(key);
  const raw = derToRawEcdsa(der, 32);
  const signature = base64url(raw);
  const token = `${unsigned}.${signature}`;
  _tokenCache = { token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return token;
}

/**
 * Convert an ASN.1 DER-encoded ECDSA signature to raw concatenated r||s.
 */
function derToRawEcdsa(der, size) {
  // DER: 0x30 len 0x02 rLen r 0x02 sLen s
  let offset = 2;
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  if (der[offset] !== 0x02) throw new Error("Invalid DER signature");
  const rLen = der[offset + 1];
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;
  if (der[offset] !== 0x02) throw new Error("Invalid DER signature");
  const sLen = der[offset + 1];
  let s = der.subarray(offset + 2, offset + 2 + sLen);
  // Trim leading zeros or left-pad to size
  if (r.length > size) r = r.subarray(r.length - size);
  if (s.length > size) s = s.subarray(s.length - size);
  const rPad = Buffer.alloc(size);
  const sPad = Buffer.alloc(size);
  r.copy(rPad, size - r.length);
  s.copy(sPad, size - s.length);
  return Buffer.concat([rPad, sPad]);
}

async function loadHttp2() {
  if (_http2Module) return _http2Module;
  try {
    _http2Module = await import("node:http2");
  } catch (err) {
    throw new Error("node:http2 unavailable: " + err.message, { cause: err });
  }
  return _http2Module;
}

/**
 * Send a notification via APNS HTTP/2.
 * @param {string} deviceToken - hex-encoded device token
 * @param {object} notification - { title, body, badge?, data?, priority? }
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
export async function sendApns(deviceToken, notification) {
  if (!deviceToken) return { ok: false, error: "token required" };
  if (!isApnsConfigured()) return { ok: false, error: "APNS not configured" };

  let jwt;
  try {
    jwt = buildProviderJwt();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const payload = {
    aps: {
      alert: {
        title: notification.title || "",
        body: notification.body || "",
      },
      sound: "default",
      badge: typeof notification.badge === "number" ? notification.badge : undefined,
    },
    ...(notification.data || {}),
  };

  const http2 = await loadHttp2().catch((e) => e);
  if (http2 instanceof Error) return { ok: false, error: http2.message };

  return new Promise((resolve) => {
    let client;
    try {
      client = http2.connect(APNS_HOST);
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    const timer = setTimeout(() => {
      try { client.close(); } catch (_) {}
      resolve({ ok: false, error: "APNS request timeout" });
    }, 15_000);

    client.on("error", (err) => {
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      resolve({ ok: false, error: err.message });
    });

    let req;
    try {
      req = client.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": APNS_BUNDLE_ID,
        "apns-priority": notification.priority === "high" ? "10" : "5",
        "apns-push-type": "alert",
        "content-type": "application/json",
      });
    } catch (err) {
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      return resolve({ ok: false, error: err.message });
    }

    let status = 0;
    let body = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      if (status >= 200 && status < 300) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `APNS ${status}: ${body.slice(0, 200)}` });
      }
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      try { client.close(); } catch (_) {}
      resolve({ ok: false, error: err.message });
    });

    req.end(JSON.stringify(payload));
  });
}

/**
 * Reset caches (for tests).
 */
export function _resetApnsCache() {
  _keyContents = null;
  _tokenCache = null;
  _http2Module = null;
}
