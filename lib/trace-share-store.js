/**
 * Signed, TTL-bound, anonymized trace sharing.
 *
 * Admins can issue a short-lived signed URL that lets outsiders (support,
 * reviewers) view a trace with secrets, PII, and workspace identifiers
 * redacted. Tokens are self-contained: an HMAC over `<base64url(payload)>`
 * with a process-level secret.
 *
 * Security rules:
 *   - HMAC-SHA256 with env TRACE_SHARE_SECRET. If unset, a random 32-byte
 *     hex secret is generated once per process and a single stderr warning
 *     is emitted. Never hardcoded.
 *   - TTL must be <= 30 days.
 *   - Revoked tokens (by HMAC hash) verify as null until process restart.
 *   - Expired or malformed tokens verify as null.
 *   - `loadAnonymizedTrace` always runs `scrubContent` with ALL rules on
 *     tool args and results, regardless of the global scrub setting.
 *
 * Token format: `<base64url(payloadJson)>.<base64url(hmacBytes)>`.
 */

import crypto from "node:crypto";
import { loadTrajectory } from "./agent-trajectory.js";
import { scrubContent } from "./content-scrubber.js";

const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_FREEFORM_CHARS = 600;
const REDACTED_WORKSPACE = "<redacted>";
const REDACTED_MODEL = "<redacted>";

/** @type {Set<string>} */
const revokedHashes = new Set();

/** @type {Map<string, Array<{runId: string, expiresAt: number, hash: string}>>} */
const createdIndex = new Map();

/** @type {Map<string, number[]>} */
const createRateLimit = new Map();
const RATE_WINDOW_MS = 5 * 60 * 1000;

let cachedSecret = null;
let warnedMissingSecret = false;

function getSecret() {
  if (cachedSecret) return cachedSecret;
  const envSecret = process.env.TRACE_SHARE_SECRET;
  if (envSecret && typeof envSecret === "string" && envSecret.length >= 16) {
    cachedSecret = envSecret;
    return cachedSecret;
  }
  cachedSecret = crypto.randomBytes(32).toString("hex");
  if (!warnedMissingSecret) {
    warnedMissingSecret = true;
    process.stderr.write(
      "[trace-share] WARNING: TRACE_SHARE_SECRET not set; using a random in-memory secret. " +
        "Tokens will not survive process restart. Set TRACE_SHARE_SECRET to persist.\n",
    );
  }
  return cachedSecret;
}

function base64urlEncode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlDecode(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64");
}

function hmacBytes(data) {
  const key = getSecret();
  return crypto.createHmac("sha256", key).update(data).digest();
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

/**
 * @typedef {object} ShareToken
 * @property {string} runId
 * @property {string} workspace
 * @property {number} expiresAt
 * @property {string} createdBy
 * @property {string[]} [redactFields]
 */

/**
 * Sign a share token. Returns `<base64url(payload)>.<base64url(hmac)>`.
 * @param {ShareToken} payload
 * @returns {string}
 */
export function signShareToken(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("signShareToken: payload must be an object");
  }
  if (!payload.runId || typeof payload.runId !== "string") {
    throw new Error("signShareToken: runId required");
  }
  if (!payload.workspace || typeof payload.workspace !== "string") {
    throw new Error("signShareToken: workspace required");
  }
  if (!payload.createdBy || typeof payload.createdBy !== "string") {
    throw new Error("signShareToken: createdBy required");
  }
  if (!Number.isFinite(payload.expiresAt)) {
    throw new Error("signShareToken: expiresAt must be a number");
  }
  const now = Date.now();
  if (payload.expiresAt <= now) {
    throw new Error("signShareToken: expiresAt must be in the future");
  }
  if (payload.expiresAt - now > MAX_TTL_MS) {
    throw new Error("signShareToken: TTL exceeds maximum of 30 days");
  }
  const redactFields = Array.isArray(payload.redactFields)
    ? payload.redactFields.filter((x) => typeof x === "string").slice(0, 32)
    : undefined;

  const normalized = {
    runId: payload.runId,
    workspace: payload.workspace,
    expiresAt: payload.expiresAt,
    createdBy: payload.createdBy,
    ...(redactFields && redactFields.length ? { redactFields } : {}),
  };
  const payloadJson = JSON.stringify(normalized);
  const payloadB64 = base64urlEncode(Buffer.from(payloadJson, "utf8"));
  const sig = hmacBytes(payloadB64);
  const sigB64 = base64urlEncode(sig);
  const token = `${payloadB64}.${sigB64}`;

  const hash = tokenHash(token);
  const arr = createdIndex.get(normalized.createdBy) || [];
  arr.push({ runId: normalized.runId, expiresAt: normalized.expiresAt, hash });
  createdIndex.set(normalized.createdBy, arr);

  return token;
}

/**
 * Verify + decode a token. Returns the payload, or null on any failure
 * (malformed, bad HMAC, expired, revoked).
 * @param {string} token
 * @returns {ShareToken | null}
 */
export function verifyShareToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  let expected;
  try {
    expected = hmacBytes(payloadB64);
  } catch {
    return null;
  }
  let provided;
  try {
    provided = base64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  let equal;
  try {
    equal = crypto.timingSafeEqual(provided, expected);
  } catch {
    return null;
  }
  if (!equal) return null;

  let payload;
  try {
    const buf = base64urlDecode(payloadB64);
    payload = JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.runId !== "string" || !payload.runId) return null;
  if (typeof payload.workspace !== "string" || !payload.workspace) return null;
  if (typeof payload.createdBy !== "string" || !payload.createdBy) return null;
  if (!Number.isFinite(payload.expiresAt)) return null;

  if (payload.expiresAt <= Date.now()) return null;

  const hash = tokenHash(token);
  if (revokedHashes.has(hash)) return null;

  return payload;
}

/**
 * Drop / redact sensitive fields from an object recursively.
 * @param {any} value
 * @param {{dropCost: boolean, redactModel: boolean}} opts
 */
function dropSensitiveFields(value, opts) {
  if (Array.isArray(value)) {
    return value.map((v) => dropSensitiveFields(v, opts));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const lk = String(k).toLowerCase();
      if (
        lk === "workspaceid" ||
        lk === "storageuserid" ||
        lk === "userid" ||
        lk === "sessionid" ||
        lk === "apikey" ||
        lk === "authorization" ||
        lk === "cookie" ||
        lk === "set-cookie"
      ) {
        continue;
      }
      if (opts.dropCost && (lk === "cost" || lk === "costusd" || lk === "costdelta" || lk === "totalcostusd")) {
        continue;
      }
      if (opts.redactModel && lk === "model") {
        out[k] = REDACTED_MODEL;
        continue;
      }
      if (typeof v === "string") {
        // .env-shaped key=value blobs: if the string looks like KEY=value pairs, drop
        if (/^[A-Z][A-Z0-9_]{2,}\s*=\s*.+/m.test(v) && /\n/.test(v)) {
          out[k] = "<redacted-env>";
          continue;
        }
        // apiKey-shaped value
        if (/^(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})$/.test(v)) {
          out[k] = "<redacted>";
          continue;
        }
        out[k] = v;
        continue;
      }
      out[k] = dropSensitiveFields(v, opts);
    }
    return out;
  }
  return value;
}

function truncate(str, max = MAX_FREEFORM_CHARS) {
  const s = typeof str === "string" ? str : JSON.stringify(str ?? "");
  if (typeof s !== "string") return "";
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function scrubString(str) {
  if (typeof str !== "string") return str;
  const r = scrubContent(str, { secrets: true, pii: true, promptInjection: true });
  return r.scrubbed;
}

/**
 * Deep-scrub any primitive string in a value (using scrubContent). Returns a
 * new value. Applied after field-drop.
 */
function deepScrub(value) {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(deepScrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepScrub(v);
    return out;
  }
  return value;
}

function toolCallsFromSteps(steps, opts) {
  if (!Array.isArray(steps)) return [];
  const byIter = new Map();
  const pending = new Map();
  const key = (it, name) => it + "\u0000" + (name || "");

  function ensureIter(it) {
    if (!byIter.has(it)) {
      byIter.set(it, { iteration: it, toolCalls: [], signals: [] });
    }
    return byIter.get(it);
  }

  function stepMs(s) {
    const t = s && (s.at || s.timestamp);
    if (!t) return 0;
    const ms = new Date(t).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const it = Number.isFinite(step.iteration) ? Number(step.iteration) : 0;
    const card = ensureIter(it);

    if (step.type === "tool_call") {
      let args = step.argsPreview;
      try {
        args = typeof args === "string" ? JSON.parse(args) : args;
      } catch {
        /* keep as string */
      }
      // Drop sensitive fields, then deep-scrub, then stringify+truncate per-field.
      const dropped = dropSensitiveFields(args, opts);
      const scrubbed = deepScrub(dropped);
      let argsRedacted;
      if (scrubbed && typeof scrubbed === "object") {
        argsRedacted = {};
        for (const [k, v] of Object.entries(scrubbed)) {
          argsRedacted[k] = truncate(typeof v === "string" ? v : JSON.stringify(v));
        }
      } else {
        argsRedacted = truncate(typeof scrubbed === "string" ? scrubbed : JSON.stringify(scrubbed ?? ""));
      }
      const tc = {
        name: step.name || "",
        ok: null,
        latencyMs: null,
        argsRedacted,
        resultPreview: null,
        _startedMs: stepMs(step),
      };
      card.toolCalls.push(tc);
      pending.set(key(it, step.name), tc);
    } else if (step.type === "tool_result") {
      const tc = pending.get(key(it, step.name));
      const preview = truncate(scrubString(typeof step.preview === "string" ? step.preview : JSON.stringify(step.preview ?? "")));
      if (tc) {
        tc.resultPreview = preview;
        tc.ok = step.ok !== false;
        const end = stepMs(step);
        if (tc._startedMs && end) {
          const d = end - tc._startedMs;
          if (Number.isFinite(d) && d >= 0) tc.latencyMs = d;
        }
        pending.delete(key(it, step.name));
      } else {
        card.toolCalls.push({
          name: step.name || "",
          ok: step.ok !== false,
          latencyMs: null,
          argsRedacted: null,
          resultPreview: preview,
        });
      }
    } else if (step.type === "tool_error") {
      const tc = pending.get(key(it, step.name));
      const msg = truncate(scrubString(typeof step.message === "string" ? step.message : JSON.stringify(step.message ?? "")));
      if (tc) {
        tc.resultPreview = msg;
        tc.ok = false;
        const end = stepMs(step);
        if (tc._startedMs && end) {
          const d = end - tc._startedMs;
          if (Number.isFinite(d) && d >= 0) tc.latencyMs = d;
        }
        pending.delete(key(it, step.name));
      } else {
        card.toolCalls.push({
          name: step.name || "",
          ok: false,
          latencyMs: null,
          argsRedacted: null,
          resultPreview: msg,
        });
      }
    } else if (
      step.type === "replan" ||
      step.type === "replan_nudge" ||
      step.type === "stagnation" ||
      step.type === "stagnation_signal" ||
      step.type === "reflection" ||
      step.type === "reflection_revision" ||
      step.type === "reflection_error"
    ) {
      card.signals.push({
        kind: step.type,
        reason: typeof step.reason === "string" ? step.reason : null,
        message: typeof step.message === "string" ? truncate(scrubString(step.message)) : null,
      });
    } else if (step.type === "stop") {
      card.signals.push({
        kind: "stop",
        reason: typeof step.reason === "string" ? step.reason : null,
      });
    }
  }

  const out = [];
  for (const card of [...byIter.values()].sort((a, b) => a.iteration - b.iteration)) {
    for (const tc of card.toolCalls) delete tc._startedMs;
    out.push(card);
  }
  return out;
}

/**
 * Load a trajectory and return a SAFE anonymized shape.
 * @param {ShareToken} token
 * @returns {Promise<object | null>}
 */
export async function loadAnonymizedTrace(token) {
  if (!token || typeof token !== "object") return null;
  if (!token.runId || !token.workspace) return null;

  const payload = await loadTrajectory(token.runId);
  if (!payload || typeof payload !== "object") return null;

  const redactFields = Array.isArray(token.redactFields) ? token.redactFields : [];
  const dropCost = redactFields.includes("costUsd");
  const redactModel = redactFields.includes("model");
  const extraDropKeys = new Set(redactFields.filter((x) => x !== "costUsd" && x !== "model"));

  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  let startMs = 0;
  let lastMs = 0;
  let stopReason = null;
  for (const s of steps) {
    const ts = s && (s.at || s.timestamp);
    if (ts) {
      const ms = new Date(ts).getTime();
      if (Number.isFinite(ms)) {
        if (!startMs || ms < startMs) startMs = ms;
        if (ms > lastMs) lastMs = ms;
      }
    }
    if (s && s.type === "stop" && typeof s.reason === "string") stopReason = s.reason;
  }

  const iterations = toolCallsFromSteps(steps, { dropCost, redactModel });

  // Additional extra-drop: walk iterations and drop any listed keys.
  if (extraDropKeys.size > 0) {
    for (const it of iterations) {
      for (const tc of it.toolCalls) {
        if (tc.argsRedacted && typeof tc.argsRedacted === "object") {
          for (const k of Object.keys(tc.argsRedacted)) {
            if (extraDropKeys.has(k)) delete tc.argsRedacted[k];
          }
        }
      }
    }
  }

  return {
    runId: payload.runId || token.runId,
    workspace: REDACTED_WORKSPACE,
    startedAt: startMs ? new Date(startMs).toISOString() : payload.recordedAt || null,
    stopReason,
    durationMs: startMs && lastMs ? Math.max(0, lastMs - startMs) : 0,
    iterations,
    sharedBy: token.createdBy,
    expiresAt: token.expiresAt,
  };
}

/**
 * Rate-limit helper: returns true if this IP has created more than max
 * tokens within the 5-minute rolling window.
 * @param {string} ip
 * @param {number} [max]
 * @returns {boolean}
 */
export function shouldRateLimitCreate(ip, max = 20) {
  const key = String(ip || "unknown");
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const arr = (createRateLimit.get(key) || []).filter((t) => t >= windowStart);
  arr.push(now);
  createRateLimit.set(key, arr);
  return arr.length > max;
}

/**
 * List active (unexpired) tokens created by a given admin.
 * @param {string} createdBy
 * @returns {Array<{runId: string, expiresAt: number}>}
 */
export function listMyTokens(createdBy) {
  const arr = createdIndex.get(String(createdBy || "")) || [];
  const now = Date.now();
  return arr
    .filter((e) => e.expiresAt > now && !revokedHashes.has(e.hash))
    .map((e) => ({ runId: e.runId, expiresAt: e.expiresAt }));
}

/**
 * Revoke a token by HMAC-hash blacklist.
 * @param {string} token
 */
export function revokeToken(token) {
  if (typeof token !== "string" || !token) return;
  revokedHashes.add(tokenHash(token));
}

/** Test helper. Not exported as part of public API surface. */
export function _resetForTests() {
  revokedHashes.clear();
  createdIndex.clear();
  createRateLimit.clear();
  cachedSecret = null;
  warnedMissingSecret = false;
}

export const _internals = { MAX_TTL_MS, MAX_FREEFORM_CHARS };
