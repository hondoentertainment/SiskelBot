/**
 * Agent Run hero SSE stream.
 *
 * Given a session id and an Express response, streams agent-run events over
 * Server-Sent Events. On connect we backfill historical events from the
 * durable agent session event log (lib/agent-session.js) and the in-memory
 * trajectory store (lib/agent-trajectory.js), then subscribe to a per-session
 * EventEmitter so downstream agent-loop callsites can push live updates.
 *
 * Wire format (per spec):
 *   event: <type>\n
 *   data: {"seq":N,"ts":"...","payload":{...}}\n
 *   \n
 *
 * Event types emitted:
 *   plan.update, tool.call, tool.result, hitl.request, hitl.resolved,
 *   artifact.new, cost.update, status.change, error, done,
 *   subagent.spawned, subagent.done
 *
 * `subagent.spawned` payload:
 *   { childSessionId: string, childRunId?: string, goal: string,
 *     profile: string, depth: number }
 *   Published by the spawn_subagent tool when a child agent session is created.
 *
 * `subagent.done` payload:
 *   { childSessionId: string, result: string (truncated),
 *     costUsd: number, iterations: number, status: string }
 *   Published by the spawn_subagent tool when a child agent session completes.
 *
 * `error` payload: { message: string, code?: string, runId?: string, iteration?: number }.
 * `error` is non-terminal — the publisher typically follows it with a `done`
 * event so SSE consumers close the stream cleanly.
 *
 * The returned emitter is exported via getAgentRunEmitter(sessionId) so
 * writers elsewhere in the codebase can publish live events without having
 * to coordinate transport concerns.
 */

import { EventEmitter } from "events";
import { getAgentSession } from "./agent-session.js";
import { loadTrajectory } from "./agent-trajectory.js";

/** @type {Map<string, EventEmitter>} */
const sessionEmitters = new Map();

const MAX_LISTENERS = 32;
const KEEPALIVE_MS = 20_000;

/**
 * Get (or lazily create) the per-session EventEmitter that agent-loop callsites
 * can emit onto. The emitter is shared by every live SSE subscriber.
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
 * Emit a live event onto a session's emitter. Intended for agent-loop callsites.
 *
 * @param {string} sessionId
 * @param {string} type - one of plan.update, tool.call, tool.result, hitl.request,
 *   hitl.resolved, artifact.new, cost.update, status.change, error, done
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
 * Clear the per-session emitter. Tests should call this between runs; also
 * safe to call in production when a session terminates.
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

/**
 * Normalize an agent-session event log entry (shape: { type, at, ... }) into
 * an Agent Run stream event tuple { type, payload }.
 *
 * @param {{ type: string, at?: string, [k: string]: unknown }} ev
 * @returns {{ type: string, payload: object } | null}
 */
function sessionEventToStream(ev) {
  if (!ev || typeof ev !== "object") return null;
  const { type, ...withAt } = ev;
  // Drop the `at` timestamp from payload — ts is already in the frame envelope.
  const rest = { ...withAt };
  delete rest.at;
  switch (type) {
    case "plan_updated":
      return { type: "plan.update", payload: rest };
    case "status":
      return { type: "status.change", payload: rest };
    case "cancel_requested":
      return { type: "status.change", payload: { status: "cancel_requested" } };
    case "run_linked":
      return { type: "status.change", payload: { linkedRun: rest.runId } };
    case "session_created":
      return { type: "status.change", payload: { status: "created" } };
    default:
      // Pass-through for future extensions. Namespace unknown events under
      // "status.change" so clients can render them in the timeline.
      return { type: "status.change", payload: { kind: type, ...rest } };
  }
}

/**
 * Normalize a trajectory step (shape: { kind, at, ... }) into a stream event.
 *
 * @param {{ kind?: string, at?: string, [k: string]: unknown }} step
 * @returns {{ type: string, payload: object } | null}
 */
function trajectoryStepToStream(step) {
  if (!step || typeof step !== "object") return null;
  const { kind, ...withAt } = step;
  const rest = { ...withAt };
  delete rest.at;
  if (!kind) return null;
  const k = String(kind);
  if (k === "tool_call" || k === "tool.call") return { type: "tool.call", payload: rest };
  if (k === "tool_result" || k === "tool.result") return { type: "tool.result", payload: rest };
  if (k === "artifact" || k === "artifact.new") return { type: "artifact.new", payload: rest };
  if (k === "cost" || k === "cost.update") return { type: "cost.update", payload: rest };
  if (k === "hitl_request" || k === "hitl.request") return { type: "hitl.request", payload: rest };
  if (k === "hitl_resolved" || k === "hitl.resolved") return { type: "hitl.resolved", payload: rest };
  return { type: "status.change", payload: { kind: k, ...rest } };
}

/**
 * Write a single SSE frame.
 *
 * @param {import('http').ServerResponse} res
 * @param {string} type
 * @param {number} seq
 * @param {string} ts
 * @param {object} payload
 * @returns {boolean}
 */
function writeSseEvent(res, type, seq, ts, payload) {
  try {
    const json = JSON.stringify({ seq, ts, payload: payload || {} });
    return res.write(`event: ${type}\ndata: ${json}\n\n`);
  } catch (_) {
    return false;
  }
}

/**
 * Stream the Agent Run SSE feed for a session.
 *
 * Caller is responsible for auth / workspace access checks. Caller must NOT
 * have written headers yet (this function sets SSE headers).
 *
 * Resolves when the client disconnects, when a "done" event is emitted, or
 * when the session is not found (404 written).
 *
 * @param {{
 *   sessionId: string,
 *   workspace?: string,
 *   userId?: string,
 *   res: import('http').ServerResponse,
 *   req?: import('http').IncomingMessage,
 *   onNotFound?: () => void,
 *   keepaliveMs?: number,
 * }} opts
 * @returns {Promise<void>}
 */
export async function streamAgentRun(opts) {
  const sessionId = String(opts?.sessionId || "").trim();
  const res = opts?.res;
  const req = opts?.req;
  const keepaliveMs = Number(opts?.keepaliveMs) > 0 ? Number(opts.keepaliveMs) : KEEPALIVE_MS;
  if (!res) throw new Error("res required");
  if (!sessionId) {
    if (typeof opts?.onNotFound === "function") opts.onNotFound();
    else safeJson(res, 400, { error: "sessionId required", code: "INVALID" });
    return;
  }

  const session = await getAgentSession(sessionId);
  if (!session) {
    if (typeof opts?.onNotFound === "function") opts.onNotFound();
    else safeJson(res, 404, { error: "Session not found", code: "NOT_FOUND" });
    return;
  }

  // SSE headers
  try {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  } catch (_) {}

  let seq = 0;
  const startedAt = new Date().toISOString();

  // Open ping for proxies + initial status
  try { res.write(`: agent-run-stream ${startedAt}\n\n`); } catch (_) {}
  writeSseEvent(res, "status.change", ++seq, new Date().toISOString(), {
    status: session.status || "running",
    sessionId,
  });

  // Backfill: durable session event log
  const sessionEvents = Array.isArray(session.events) ? session.events : [];
  for (const ev of sessionEvents) {
    const mapped = sessionEventToStream(ev);
    if (!mapped) continue;
    const ts = typeof ev.at === "string" ? ev.at : new Date().toISOString();
    writeSseEvent(res, mapped.type, ++seq, ts, mapped.payload);
  }

  // Backfill: trajectory steps (newest run first, then oldest)
  const runIds = Array.isArray(session.runIds) ? [...session.runIds].reverse() : [];
  for (const runId of runIds) {
    let traj = null;
    try {
      traj = await loadTrajectory(runId);
    } catch (_) { /* ignore */ }
    if (!traj) continue;
    const steps = Array.isArray(traj.steps) ? traj.steps : [];
    for (const step of steps) {
      const mapped = trajectoryStepToStream(step);
      if (!mapped) continue;
      const ts = typeof step.at === "string" ? step.at : new Date().toISOString();
      writeSseEvent(res, mapped.type, ++seq, ts, { ...mapped.payload, runId });
    }
  }

  // Go live
  const emitter = getAgentRunEmitter(sessionId);
  let ended = false;
  let keepaliveTimer = null;
  /** @type {(() => void) | null} */
  let close = null;

  function writeKeepalive() {
    if (ended) return;
    try { res.write(": keepalive\n\n"); } catch (_) {}
  }
  keepaliveTimer = setInterval(writeKeepalive, keepaliveMs);
  if (keepaliveTimer && typeof keepaliveTimer.unref === "function") keepaliveTimer.unref();

  const onEvent = (ev) => {
    if (ended || !ev || !ev.type) return;
    writeSseEvent(res, ev.type, ++seq, new Date().toISOString(), ev.payload);
    if (ev.type === "done" && close) close();
  };

  return new Promise((resolve) => {
    close = function close() {
      if (ended) return;
      ended = true;
      try { emitter.off("event", onEvent); } catch (_) {}
      if (keepaliveTimer) {
        try { clearInterval(keepaliveTimer); } catch (_) {}
        keepaliveTimer = null;
      }
      try { res.end(); } catch (_) {}
      resolve();
    };

    emitter.on("event", onEvent);

    if (req) {
      req.on("close", close);
      req.on("aborted", close);
      req.on("error", close);
    }
    res.on("close", close);
    res.on("error", close);
  });
}

function safeJson(res, status, body) {
  try {
    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
    }
    res.end(JSON.stringify(body));
  } catch (_) { /* ignore */ }
}

// Test helpers
export function __resetAgentRunStreamForTests() {
  for (const [, e] of sessionEmitters) {
    try { e.removeAllListeners(); } catch (_) {}
  }
  sessionEmitters.clear();
}
