/**
 * Agent Run hero SSE stream — per-session EventEmitter for live agent events.
 *
 * The agent loop publishes events (token, status.change, done, etc.) onto
 * per-session emitters. SSE subscribers receive them in real-time.
 *
 * @module agent-run-stream
 */

import { EventEmitter } from "events";

/** @type {Map<string, EventEmitter>} */
const sessionEmitters = new Map();

const MAX_LISTENERS = 32;

/**
 * Get (or lazily create) the per-session EventEmitter.
 *
 * @param {string} sessionId
 * @returns {EventEmitter}
 */
export function getAgentRunEmitter(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("sessionId required");
  let emitter = sessionEmitters.get(id);
  if (!emitter) {
    emitter = new EventEmitter();
    emitter.setMaxListeners(MAX_LISTENERS);
    sessionEmitters.set(id, emitter);
  }
  return emitter;
}

/**
 * Emit a live event onto a session's emitter.
 *
 * @param {string} sessionId
 * @param {string} type - event type (token, status.change, done, etc.)
 * @param {object} payload
 */
export function publishAgentRunEvent(sessionId, type, payload) {
  const id = String(sessionId || "").trim();
  if (!id || !type) return;
  const emitter = sessionEmitters.get(id);
  if (!emitter) return;
  emitter.emit("event", { type: String(type), payload: payload || {} });
}

/**
 * Clear the per-session emitter.
 *
 * @param {string} sessionId
 */
export function disposeAgentRunEmitter(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return;
  const emitter = sessionEmitters.get(id);
  if (emitter) {
    emitter.removeAllListeners();
    sessionEmitters.delete(id);
  }
}

/** Test helper — clears all emitters. */
export function __resetAgentRunStreamForTests() {
  for (const [, e] of sessionEmitters) {
    try { e.removeAllListeners(); } catch (_) {}
  }
  sessionEmitters.clear();
}
