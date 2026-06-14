/**
 * Phase 36.1: Service-to-service authentication tokens.
 *
 * Implements a compact JWT-like token signed with HMAC-SHA256 using
 * SERVICE_TOKEN_SECRET. Tokens carry the issuing service id, granted scopes,
 * issue/expiry timestamps, and a random nonce to enable replay protection.
 *
 * Token format:  base64url(headerJSON).base64url(payloadJSON).base64url(signature)
 *   header  = { alg: "HS256", typ: "SVC" }
 *   payload = { sub, scopes, iat, exp, nonce, aud? }
 *
 * The nonce store is in-memory; callers can supply their own Set via
 * `setSeenNonceStore` for distributed deployments (e.g., Redis-backed).
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const DEFAULT_TTL_SECONDS = 300; // 5 minutes
const MAX_TTL_SECONDS = 3600; // 1 hour ceiling

// Replay-protection nonce store. Stores nonces that have been *consumed*
// (via `consumeNonce`). A production deployment should replace this with a
// persistent store backed by Redis or similar.
let seenNonces = new Map();

// Periodic cleanup: expire nonce entries older than MAX_TTL_SECONDS.
function pruneNonces() {
  const cutoff = Date.now() - MAX_TTL_SECONDS * 1000;
  for (const [nonce, ts] of seenNonces.entries()) {
    if (ts < cutoff) seenNonces.delete(nonce);
  }
}

export function setSeenNonceStore(store) {
  seenNonces = store;
}

export function _resetSeenNoncesForTesting() {
  seenNonces = new Map();
}

function getSecret() {
  const s = process.env.SERVICE_TOKEN_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "SERVICE_TOKEN_SECRET must be set to at least 16 characters to use service tokens."
    );
  }
  return s;
}

function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecodeToBuffer(s) {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  return Buffer.from(normalized, "base64");
}

function base64urlDecodeToString(s) {
  return base64urlDecodeToBuffer(s).toString("utf8");
}

function sign(data, secret) {
  return createHmac("sha256", secret).update(data).digest();
}

/**
 * Issue a signed service token.
 *
 * @param {string} serviceId
 * @param {string[]} scopes
 * @param {number} [ttlSeconds]
 * @param {object} [extra] - Optional claims to embed (e.g., { aud }).
 * @returns {{ token: string, payload: object }}
 */
export function issueServiceToken(serviceId, scopes, ttlSeconds, extra = {}) {
  if (!serviceId || typeof serviceId !== "string") {
    throw new Error("serviceId is required");
  }
  if (!Array.isArray(scopes)) {
    throw new Error("scopes must be an array");
  }
  const ttl = Math.min(
    Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
    MAX_TTL_SECONDS
  );
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    sub: serviceId,
    scopes: scopes.map(String),
    iat,
    exp: iat + ttl,
    nonce: randomBytes(16).toString("hex"),
    ...extra,
  };
  const header = { alg: "HS256", typ: "SVC" };
  const secret = getSecret();

  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const sig = base64urlEncode(sign(signingInput, secret));
  return { token: `${signingInput}.${sig}`, payload };
}

/**
 * Verify a service token signature and expiry.
 *
 * @param {string} token
 * @returns {{ valid: boolean, reason?: string, serviceId?: string, scopes?: string[], payload?: object }}
 */
export function verifyServiceToken(token) {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "missing_token" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "malformed" };
  }
  const [h, p, s] = parts;
  let secret;
  try {
    secret = getSecret();
  } catch (err) {
    return { valid: false, reason: err.message };
  }

  const expectedSig = sign(`${h}.${p}`, secret);
  let providedSig;
  try {
    providedSig = base64urlDecodeToBuffer(s);
  } catch {
    return { valid: false, reason: "bad_signature_encoding" };
  }
  if (providedSig.length !== expectedSig.length) {
    return { valid: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(providedSig, expectedSig)) {
    return { valid: false, reason: "bad_signature" };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToString(p));
  } catch {
    return { valid: false, reason: "bad_payload" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) {
    return { valid: false, reason: "expired", payload };
  }
  if (typeof payload.iat !== "number" || payload.iat > now + 60) {
    return { valid: false, reason: "iat_in_future", payload };
  }

  return {
    valid: true,
    serviceId: payload.sub,
    scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
    payload,
  };
}

/**
 * Mark a nonce as consumed. Returns false if it was already seen (replay).
 */
export function consumeNonce(nonce) {
  if (!nonce) return false;
  pruneNonces();
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, Date.now());
  return true;
}

/**
 * Exchange a user token (API key or session id) for a short-lived service token.
 * The user must be validated by the caller (e.g. via chatAuth). This helper
 * encodes the user identity and target service into a service token payload.
 *
 * @param {{ userId: string, scopes?: string[] } | string} userToken - validated user context or raw token hash
 * @param {string} targetService - the service id the token will be presented to
 * @param {number} [ttlSeconds]
 * @returns {{ token: string, payload: object }}
 */
export function exchangeUserTokenForServiceToken(userToken, targetService, ttlSeconds) {
  if (!targetService || typeof targetService !== "string") {
    throw new Error("targetService is required");
  }
  let userId;
  let scopes;
  if (typeof userToken === "string") {
    userId = userToken;
    scopes = ["read"];
  } else if (userToken && typeof userToken === "object") {
    userId = userToken.userId || userToken.sub;
    scopes = Array.isArray(userToken.scopes) ? userToken.scopes : ["read"];
  } else {
    throw new Error("userToken must be a string or object with userId");
  }
  if (!userId) throw new Error("userToken did not yield a userId");

  // Exchanged tokens always carry the user subject and the target audience.
  return issueServiceToken(
    `user:${userId}`,
    scopes,
    Math.min(Math.max(1, Number(ttlSeconds) || 120), 600), // exchanged tokens are very short-lived
    { aud: targetService, on_behalf_of: userId }
  );
}

/**
 * Express middleware factory. Validates a service token from the
 * `Authorization: Bearer` header and checks that it carries the required scope.
 *
 * @param {string} requiredScope
 * @param {{ checkReplay?: boolean }} [opts]
 */
export function serviceTokenMiddleware(requiredScope, opts = {}) {
  const checkReplay = opts.checkReplay === true;
  return function serviceTokenMiddlewareHandler(req, res, next) {
    const auth = req.headers?.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const headerToken = req.headers?.["x-service-token"];
    const token = bearer || headerToken || null;
    if (!token) {
      return res.status(401).json({
        error: "Service token required",
        code: "SERVICE_TOKEN_REQUIRED",
      });
    }

    const result = verifyServiceToken(token);
    if (!result.valid) {
      return res.status(401).json({
        error: "Invalid service token",
        code: "SERVICE_TOKEN_INVALID",
        reason: result.reason,
      });
    }

    if (requiredScope && !result.scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: "Service token missing required scope",
        code: "SERVICE_TOKEN_SCOPE",
        required: requiredScope,
      });
    }

    if (checkReplay) {
      const nonce = result.payload?.nonce;
      if (!consumeNonce(nonce)) {
        return res.status(401).json({
          error: "Service token replayed",
          code: "SERVICE_TOKEN_REPLAY",
        });
      }
    }

    req.serviceToken = {
      serviceId: result.serviceId,
      scopes: result.scopes,
      payload: result.payload,
    };
    return next();
  };
}
