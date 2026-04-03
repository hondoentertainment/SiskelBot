/**
 * In-memory store for execute_step human-in-the-loop resume tokens (Phase HITL).
 * One-time use; TTL prevents unbounded growth.
 */
import { randomBytes } from "crypto";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, { expiresAt: number; state: object }>} */
const store = new Map();

function prune() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now > v.expiresAt) store.delete(k);
  }
}

/**
 * @param {object} state - Serializable continuation payload
 * @param {number} [ttlMs]
 * @returns {string} resume token
 */
export function saveHitlState(state, ttlMs = DEFAULT_TTL_MS) {
  prune();
  const token = randomBytes(24).toString("hex");
  store.set(token, { expiresAt: Date.now() + ttlMs, state });
  return token;
}

/**
 * @param {string} token
 * @returns {object | null} state or null if missing/expired
 */
export function peekHitlState(token) {
  prune();
  const id = String(token || "").trim();
  if (!id) return null;
  const row = store.get(id);
  if (!row || Date.now() > row.expiresAt) {
    store.delete(id);
    return null;
  }
  return row.state;
}

/**
 * @param {string} token
 * @returns {object | null}
 */
export function takeHitlState(token) {
  const st = peekHitlState(token);
  const id = String(token || "").trim();
  if (st) store.delete(id);
  return st;
}
