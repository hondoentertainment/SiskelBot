/**
 * Phase 37: Backend circuit breaker.
 * After N consecutive failures, fail fast with 503 instead of waiting on backend.
 * Resets after cooldown period.
 *
 * Tri-state model:
 *   - "closed": healthy. Failures accumulate until threshold.
 *   - "open": tripped. All calls fail fast until cooldown elapses.
 *   - "half_open": cooldown elapsed, awaiting a probe outcome. A success
 *     closes the breaker (state cleared); a failure re-opens it with a
 *     fresh cooldown window.
 *
 * Backward compatibility:
 *   - `isOpen()` keeps its legacy `{ open, retryAfterMs? }` return shape.
 *     By default it reports "cooldown elapsed" as `open:false` (i.e. as
 *     recovered) — this preserves the pre-existing contract used by
 *     lib/metrics.js, lib/ab-router.js, lib/backend-fetch.js, and the
 *     existing test that asserts `isOpen(...).open === false` after the
 *     cooldown window passes, and also that a subsequent failure starts
 *     from a clean slate. In that default mode `isOpen()` does NOT
 *     promote the entry to half_open — it simply clears stale state so
 *     the old "fresh start" contract holds.
 *   - Callers that want tri-state awareness should use `getBreakerState()`
 *     / `getBreakerSnapshot()`, or pass `{ halfOpenAsOpen: true }` to get
 *     strict fail-fast behavior where half_open is reported as `open:true`.
 *   - `execute()` is the canonical path that drives half_open transitions:
 *     when cooldown elapses it promotes the entry to half_open, lets one
 *     probe through, and closes or re-opens based on the outcome.
 */

import { createLogger } from "./logger.js";

const log = createLogger('circuit-breaker');

const CIRCUIT_FAILURE_THRESHOLD = Number(process.env.CIRCUIT_BREAKER_FAILURES) || 5;
const CIRCUIT_COOLDOWN_MS = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS) || 30_000;

/**
 * @typedef {{ failures: number; lastFailure: number; openUntil: number; halfOpen: boolean }} BreakerState
 */

/** @type {Map<string, BreakerState>} */
const state = new Map();

function getKey(backend) {
  return `backend:${backend}`;
}

function backendFromKey(key) {
  return key.startsWith("backend:") ? key.slice("backend:".length) : key;
}

/**
 * Record a success (resets failure count and closes the breaker).
 * @param {string} backend - Backend identifier (ollama, vllm, openai)
 */
export function recordSuccess(backend) {
  const key = getKey(backend);
  state.delete(key);
}

/**
 * Record a failure. Returns true if circuit should open.
 * If the breaker is currently in half_open, a failure immediately
 * re-opens it with a fresh cooldown window regardless of failure count.
 * @param {string} backend - Backend identifier
 * @returns {boolean} - true if circuit is now open
 */
export function recordFailure(backend) {
  const key = getKey(backend);
  let s = state.get(key);
  if (!s) {
    s = { failures: 0, lastFailure: 0, openUntil: 0, halfOpen: false };
    state.set(key, s);
  }
  const now = Date.now();
  s.failures++;
  s.lastFailure = now;
  const cooldownElapsed =
    s.failures >= CIRCUIT_FAILURE_THRESHOLD &&
    s.openUntil > 0 &&
    now >= s.openUntil &&
    !s.halfOpen;
  if (s.halfOpen || cooldownElapsed) {
    s.halfOpen = false;
    s.openUntil = now + CIRCUIT_COOLDOWN_MS;
    log.warn("Circuit re-opened after half-open failure", {
      backend,
      failures: s.failures,
      cooldownMs: CIRCUIT_COOLDOWN_MS,
    });
    return true;
  }
  if (s.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    s.openUntil = s.lastFailure + CIRCUIT_COOLDOWN_MS;
    log.warn("Circuit opened", { backend, failures: s.failures, cooldownMs: CIRCUIT_COOLDOWN_MS });
    return true;
  }
  return false;
}

/**
 * Compute the observable tri-state without mutating the entry. Used by
 * getBreakerState / getBreakerSnapshot so inspection is side-effect free.
 * @param {BreakerState|undefined} s
 * @returns {"closed"|"open"|"half_open"}
 */
function observeState(s) {
  if (!s) return "closed";
  if (s.halfOpen) return "half_open";
  if (s.failures < CIRCUIT_FAILURE_THRESHOLD) return "closed";
  const now = Date.now();
  if (now >= s.openUntil) return "half_open";
  return "open";
}

/**
 * Promote an entry to half_open when its cooldown has elapsed. Used by
 * execute() to allow one probe through. Returns the post-promotion state.
 * @param {BreakerState|undefined} s
 * @returns {"closed"|"open"|"half_open"}
 */
function promoteState(s) {
  if (!s) return "closed";
  if (s.halfOpen) return "half_open";
  if (s.failures < CIRCUIT_FAILURE_THRESHOLD) return "closed";
  const now = Date.now();
  if (now >= s.openUntil) {
    s.halfOpen = true;
    return "half_open";
  }
  return "open";
}

/**
 * Get the tri-state label for a backend. Does not mutate state.
 * @param {string} backend
 * @returns {"closed"|"open"|"half_open"}
 */
export function getBreakerState(backend) {
  const key = getKey(backend);
  const s = state.get(key);
  return observeState(s);
}

/**
 * Build a snapshot row for a single backend. Pure — does not mutate state.
 * @param {string} backend
 * @returns {{ name: string, state: "closed"|"open"|"half_open", failures: number, lastFailureAt: string|null, cooldownRemainingMs: number }}
 */
function snapshotRow(backend) {
  const key = getKey(backend);
  const s = state.get(key);
  const st = observeState(s);
  const now = Date.now();
  const cooldownRemainingMs = s && st === "open" && s.openUntil > now ? s.openUntil - now : 0;
  return {
    name: backend,
    state: st,
    failures: s ? s.failures : 0,
    lastFailureAt: s && s.lastFailure ? new Date(s.lastFailure).toISOString() : null,
    cooldownRemainingMs,
  };
}

/**
 * Get a rich snapshot for one or all known breakers.
 *
 * - With a name, returns a single row `{name, state, failures, lastFailureAt, cooldownRemainingMs}`.
 *   A row is returned even when no state has been recorded yet (fresh closed breaker).
 * - Without a name, returns an array of rows for every breaker that has
 *   accumulated state (every backend that has ever failed/succeeded).
 *
 * @param {string} [backend]
 * @returns {object|object[]}
 */
export function getBreakerSnapshot(backend) {
  if (typeof backend === "string" && backend.length > 0) {
    return snapshotRow(backend);
  }
  const rows = [];
  for (const key of state.keys()) {
    rows.push(snapshotRow(backendFromKey(key)));
  }
  return rows;
}

/**
 * Check if circuit is open for this backend.
 *
 * Legacy contract preserved: return shape is `{ open, retryAfterMs? }`.
 * By default (halfOpenAsOpen omitted / false), once the cooldown window has
 * elapsed the breaker is reported as `open:false` — matching the old
 * "cooldown elapsed ⇒ recovered" behavior. In the default mode this call
 * also clears stale entries whose cooldown has passed, so a subsequent
 * failure starts from a clean slate (threshold counter resets).
 *
 * Pass `{ halfOpenAsOpen: true }` for tri-state-aware fail-fast behavior:
 * half_open will be reported as `open:true` (with a `state: "half_open"`
 * marker and `retryAfterMs: 0`) so callers can keep failing fast until a
 * probe succeeds. In that mode state is not cleared.
 *
 * @param {string} backend - Backend identifier
 * @param {{ halfOpenAsOpen?: boolean }} [opts]
 * @returns {{ open: boolean; retryAfterMs?: number; state?: string }}
 */
export function isOpen(backend, opts) {
  const halfOpenAsOpen = !!(opts && opts.halfOpenAsOpen === true);
  const key = getKey(backend);
  const s = state.get(key);
  if (!s || s.failures < CIRCUIT_FAILURE_THRESHOLD) {
    if (s && s.halfOpen) {
      if (halfOpenAsOpen) {
        return { open: true, retryAfterMs: 0, state: "half_open" };
      }
      return { open: false, state: "half_open" };
    }
    return { open: false };
  }
  const now = Date.now();
  if (now >= s.openUntil) {
    if (halfOpenAsOpen) {
      // Do not mutate: leave caller to drive the half_open probe via execute().
      return { open: true, retryAfterMs: 0, state: "half_open" };
    }
    // Legacy behavior: cooldown elapsed ⇒ clear state and report closed so
    // the next attempt starts from a clean slate.
    state.delete(key);
    log.info("Circuit closed after cooldown", { backend });
    return { open: false };
  }
  return { open: true, retryAfterMs: s.openUntil - now, state: "open" };
}

/**
 * Execute an async fn with circuit breaker. On success, records success; on failure, records failure.
 *
 * When cooldown has elapsed on an open breaker, this promotes the entry
 * to half_open and lets exactly one probe through; the outcome of that
 * probe then closes the breaker (success) or re-opens it with a fresh
 * cooldown (failure).
 *
 * @param {string} backend - Backend identifier
 * @param {() => Promise<Response>} fn - Async function that returns fetch Response
 * @returns {Promise<Response>}
 * @throws {Error} With code CIRCUIT_OPEN when circuit is open; rethrows on backend error
 */
export async function execute(backend, fn) {
  const key = getKey(backend);
  const s = state.get(key);
  const st = promoteState(s);
  if (st === "open") {
    const err = new Error("Backend temporarily unavailable (circuit breaker open)");
    err.code = "CIRCUIT_OPEN";
    err.retryAfterMs = s && s.openUntil > Date.now() ? s.openUntil - Date.now() : 0;
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
