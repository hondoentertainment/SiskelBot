/**
 * Phase 37: Backend circuit breaker.
 * After N consecutive failures, fail fast with 503 instead of waiting on backend.
 * Resets after cooldown period.
 */

const CIRCUIT_FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURES) || 5;
const CIRCUIT_COOLDOWN_MS = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS) || 30_000;

/** @type {Map<string, { failures: number; lastFailure: number; openUntil: number }>} */
const state = new Map();

function getKey(backend) {
  return `backend:${backend}`;
}

/**
 * Record a success (resets failure count).
 * @param {string} backend - Backend identifier (ollama, vllm, openai)
 */
export function recordSuccess(backend) {
  const key = getKey(backend);
  state.delete(key);
}

/**
 * Record a failure. Returns true if circuit should open.
 * @param {string} backend - Backend identifier
 * @returns {boolean} - true if circuit is now open
 */
export function recordFailure(backend) {
  const key = getKey(backend);
  let s = state.get(key);
  if (!s) {
    s = { failures: 0, lastFailure: 0, openUntil: 0 };
    state.set(key, s);
  }
  s.failures++;
  s.lastFailure = Date.now();
  if (s.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    s.openUntil = s.lastFailure + CIRCUIT_COOLDOWN_MS;
    return true;
  }
  return false;
}

/**
 * Check if circuit is open for this backend.
 * @param {string} backend - Backend identifier
 * @returns {{ open: boolean; retryAfterMs?: number }} - open and optional retry-after ms
 */
export function isOpen(backend) {
  const key = getKey(backend);
  const s = state.get(key);
  if (!s || s.failures < CIRCUIT_FAILURE_THRESHOLD) return { open: false };
  const now = Date.now();
  if (now >= s.openUntil) {
    state.delete(key);
    return { open: false };
  }
  return { open: true, retryAfterMs: s.openUntil - now };
}

/**
 * Execute an async fn with circuit breaker. On success, records success; on failure, records failure.
 * @param {string} backend - Backend identifier
 * @param {() => Promise<Response>} fn - Async function that returns fetch Response
 * @returns {Promise<Response>}
 * @throws {Error} With code CIRCUIT_OPEN when circuit is open; rethrows on backend error
 */
export async function execute(backend, fn) {
  const check = isOpen(backend);
  if (check.open) {
    const err = new Error("Backend temporarily unavailable (circuit breaker open)");
    err.code = "CIRCUIT_OPEN";
    err.retryAfterMs = check.retryAfterMs;
    throw err;
  }
  try {
    const res = await fn();
    if (res.ok) {
      recordSuccess(backend);
    } else {
      recordFailure(backend);
    }
    return res;
  } catch (e) {
    recordFailure(backend);
    throw e;
  }
}
