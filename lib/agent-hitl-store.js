/**
 * In-memory store for execute_step human-in-the-loop resume tokens (Phase HITL).
 * One-time use; TTL prevents unbounded growth.
 *
 * When a saved state carries a `sessionId` (set by the caller from the active
 * agent session), we publish corresponding hitl.request / hitl.resolved events
 * on the Agent Run stream so the 4-pane hero UI can render live approvals.
 */
import { randomBytes } from "crypto";
import { publishAgentRunEvent } from "./agent-run-stream.js";

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
 * Best-effort extraction of the first HITL tool name, approval summary, and
 * detail from a saved state. Tolerant of missing / malformed shapes.
 * @param {object | null | undefined} state
 */
function buildHitlRequestPayload(state, approvalId) {
  const payload = { approvalId };
  if (!state || typeof state !== "object") return payload;
  const snapshot = Array.isArray(state.toolCallsSnapshot) ? state.toolCallsSnapshot : [];
  const hitlIds = Array.isArray(state.hitlToolCallIds) ? state.hitlToolCallIds : [];
  const firstHitl = hitlIds.length
    ? snapshot.find((tc) => tc && tc.id === hitlIds[0])
    : null;
  const toolName = firstHitl?.function?.name || "execute_step";
  payload.tool = toolName;
  const argsById = state.hitlArgsById || {};
  const firstArgs = hitlIds.length ? argsById[hitlIds[0]] : null;
  if (firstArgs && typeof firstArgs === "object") {
    const action = typeof firstArgs.action === "string" ? firstArgs.action : "";
    if (action) payload.summary = `${toolName}: ${action}`;
    try {
      const json = JSON.stringify(firstArgs);
      payload.detail = json.length > 400 ? `${json.slice(0, 400)}…` : json;
    } catch {
      /* ignore serialization errors */
    }
  }
  return payload;
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
  try {
    const sessionId = state && typeof state === "object" ? state.sessionId : null;
    if (sessionId) {
      publishAgentRunEvent(sessionId, "hitl.request", buildHitlRequestPayload(state, token));
    }
  } catch {
    /* publishing must never break the save path */
  }
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
 * Consume an approval token. When a `decision` is provided and the saved
 * state carries a `sessionId`, a `hitl.resolved` event is emitted on the
 * Agent Run stream so connected clients can retire the pending approval card.
 *
 * @param {string} token
 * @param {{ decision?: "approve" | "deny" }} [opts]
 * @returns {object | null}
 */
export function takeHitlState(token, opts) {
  const st = peekHitlState(token);
  const id = String(token || "").trim();
  if (st) store.delete(id);
  if (st && opts && typeof opts.decision === "string") {
    try {
      const sessionId = st && typeof st === "object" ? st.sessionId : null;
      if (sessionId) {
        publishAgentRunEvent(sessionId, "hitl.resolved", {
          approvalId: id,
          decision: opts.decision,
        });
      }
    } catch {
      /* publishing must never break the consumer */
    }
  }
  return st;
}
