/**
 * Replay tokens: mint, verify, and revoke signed short-lived tokens that grant
 * read-only access to an agent run's recorded trajectory. Tokens are self-
 * contained JWT-like bearer strings shaped as:
 *
 *   base64url(headerJson).base64url(payloadJson).base64url(hmacSha256)
 *
 * Claims include a unique `jti` so tokens can be revoked via a storage-backed
 * blacklist. Secret resolution: REPLAY_TOKEN_SECRET -> SESSION_SECRET; if
 * neither is configured the module throws when a token is minted/verified.
 */
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const TOKEN_SCOPE = "replay:read";
const HEADER = { alg: "HS256", typ: "REPLAY" };
const MAX_REVOCATIONS = Math.min(
  100_000,
  Math.max(100, Number(process.env.REPLAY_REVOKED_MAX) || 10_000),
);

function revocationsPath() {
  return join(getDataDir(), "replay-revoked.json");
}

function base64UrlEncode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(str) {
  if (typeof str !== "string") throw new Error("token segment must be a string");
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function resolveSecret() {
  const s = process.env.REPLAY_TOKEN_SECRET || process.env.SESSION_SECRET;
  if (!s || typeof s !== "string" || !s.trim()) {
    const err = new Error(
      "Replay tokens require REPLAY_TOKEN_SECRET (or SESSION_SECRET) to be set.",
    );
    /** @type {any} */ (err).code = "REPLAY_SECRET_MISSING";
    throw err;
  }
  return s;
}

function signSegments(header64, payload64) {
  const secret = resolveSecret();
  return createHmac("sha256", secret).update(`${header64}.${payload64}`).digest();
}

function splitToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;
  return { h, p, s };
}

async function loadRevocations() {
  const raw = await readJsonPath(revocationsPath(), { _version: 1, ids: {} });
  const ids = raw && typeof raw.ids === "object" && !Array.isArray(raw.ids) ? raw.ids : {};
  return { _version: 1, ids };
}

function pruneRevocations(store) {
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [jti, meta] of Object.entries(store.ids)) {
    if (meta && typeof meta.exp === "number" && meta.exp < nowSec) {
      delete store.ids[jti];
    }
  }
  const entries = Object.entries(store.ids);
  if (entries.length <= MAX_REVOCATIONS) return;
  entries.sort(
    (a, b) => (Number(a[1]?.revokedAt) || 0) - (Number(b[1]?.revokedAt) || 0),
  );
  while (entries.length > MAX_REVOCATIONS) {
    const drop = entries.shift();
    if (drop) delete store.ids[drop[0]];
  }
}

/**
 * Mint a signed replay token for a run.
 * @param {{ runId: string, workspaceId: string, userId: string, ttlMs?: number, sessionId?: string }} opts
 * @returns {string}
 */
export function mintReplayToken(opts) {
  const runId = String(opts?.runId || "").trim();
  const workspaceId = String(opts?.workspaceId || "").trim();
  const userId = String(opts?.userId || "").trim();
  const sessionId = opts?.sessionId ? String(opts.sessionId).trim() : "";
  if (!runId) throw new Error("runId is required");
  if (!workspaceId) throw new Error("workspaceId is required");
  if (!userId) throw new Error("userId is required");
  const ttlMs = Math.max(60_000, Number(opts?.ttlMs) || 7 * 24 * 3600 * 1000);
  const iatMs = Date.now();
  const expMs = iatMs + ttlMs;
  /** @type {Record<string, unknown>} */
  const payload = {
    jti: randomUUID(),
    iat: Math.floor(iatMs / 1000),
    exp: Math.floor(expMs / 1000),
    scope: TOKEN_SCOPE,
    runId,
    workspaceId,
    userId,
  };
  if (sessionId) payload.sessionId = sessionId;
  const header64 = base64UrlEncode(JSON.stringify(HEADER));
  const payload64 = base64UrlEncode(JSON.stringify(payload));
  const sig = signSegments(header64, payload64);
  const sig64 = base64UrlEncode(sig);
  return `${header64}.${payload64}.${sig64}`;
}

/**
 * Decode (without side-effects) the payload from a token. Returns null on error.
 * @param {string} token
 * @returns {object | null}
 */
export function decodeReplayTokenPayload(token) {
  const parts = splitToken(token);
  if (!parts) return null;
  try {
    const raw = base64UrlDecode(parts.p).toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Verify a replay token. Checks signature, expiry, scope, and revocation list.
 * @param {string} token
 * @returns {Promise<{ valid: boolean, claims: object | null, reason: string | null }>}
 */
export async function verifyReplayToken(token) {
  const parts = splitToken(token);
  if (!parts) return { valid: false, claims: null, reason: "MALFORMED" };

  let expectedSig;
  try {
    expectedSig = signSegments(parts.h, parts.p);
  } catch (err) {
    if (err && /** @type {any} */ (err).code === "REPLAY_SECRET_MISSING") throw err;
    return { valid: false, claims: null, reason: "SIGNATURE_ERROR" };
  }

  let givenSig;
  try {
    givenSig = base64UrlDecode(parts.s);
  } catch {
    return { valid: false, claims: null, reason: "MALFORMED_SIGNATURE" };
  }
  if (givenSig.length !== expectedSig.length) {
    return { valid: false, claims: null, reason: "BAD_SIGNATURE" };
  }
  if (!timingSafeEqual(givenSig, expectedSig)) {
    return { valid: false, claims: null, reason: "BAD_SIGNATURE" };
  }

  let header;
  let claims;
  try {
    header = JSON.parse(base64UrlDecode(parts.h).toString("utf8"));
    claims = JSON.parse(base64UrlDecode(parts.p).toString("utf8"));
  } catch {
    return { valid: false, claims: null, reason: "MALFORMED_JSON" };
  }
  if (!header || header.alg !== "HS256" || header.typ !== "REPLAY") {
    return { valid: false, claims: null, reason: "BAD_HEADER" };
  }
  if (!claims || typeof claims !== "object") {
    return { valid: false, claims: null, reason: "BAD_CLAIMS" };
  }
  if (claims.scope !== TOKEN_SCOPE) {
    return { valid: false, claims: null, reason: "BAD_SCOPE" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
    return { valid: false, claims: null, reason: "EXPIRED" };
  }
  if (typeof claims.iat !== "number" || claims.iat > nowSec + 300) {
    return { valid: false, claims: null, reason: "BAD_IAT" };
  }
  if (!claims.jti || typeof claims.jti !== "string") {
    return { valid: false, claims: null, reason: "MISSING_JTI" };
  }
  if (!claims.runId || typeof claims.runId !== "string") {
    return { valid: false, claims: null, reason: "MISSING_RUN_ID" };
  }

  const store = await loadRevocations();
  if (store.ids[claims.jti]) {
    return { valid: false, claims: null, reason: "REVOKED" };
  }
  return { valid: true, claims, reason: null };
}

/**
 * Revoke a token. Persists the token's jti so future verifications fail.
 * Returns `{ ok, reason? }`.
 * @param {string} token
 * @returns {Promise<{ ok: boolean, reason?: string, jti?: string }>}
 */
export async function revokeReplayToken(token) {
  const parts = splitToken(token);
  if (!parts) return { ok: false, reason: "MALFORMED" };

  let expectedSig;
  try {
    expectedSig = signSegments(parts.h, parts.p);
  } catch (err) {
    if (err && /** @type {any} */ (err).code === "REPLAY_SECRET_MISSING") throw err;
    return { ok: false, reason: "SIGNATURE_ERROR" };
  }

  let givenSig;
  try {
    givenSig = base64UrlDecode(parts.s);
  } catch {
    return { ok: false, reason: "MALFORMED_SIGNATURE" };
  }
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(parts.p).toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED_JSON" };
  }
  if (!claims?.jti) return { ok: false, reason: "MISSING_JTI" };

  const path = revocationsPath();
  await withPathLock(path, async () => {
    const store = await loadRevocations();
    store.ids[claims.jti] = {
      revokedAt: Math.floor(Date.now() / 1000),
      exp: typeof claims.exp === "number" ? claims.exp : 0,
      runId: claims.runId || null,
    };
    pruneRevocations(store);
    await writeJsonPath(path, store);
  });
  return { ok: true, jti: claims.jti };
}

/**
 * Test-only helper: check whether a jti is currently revoked.
 * @param {string} jti
 * @returns {Promise<boolean>}
 */
export async function isReplayJtiRevoked(jti) {
  if (!jti) return false;
  const store = await loadRevocations();
  return !!store.ids[jti];
}

export const __replayTokenScope = TOKEN_SCOPE;
