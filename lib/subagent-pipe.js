/**
 * Real-time message piping between parent and child agent sessions.
 *
 * Subscribes to a child session's EventEmitter and forwards selected event
 * types to the parent's emitter as `subagent.event`, enabling the parent (or
 * an orchestrator) to observe the child's tool-call stream while it runs and
 * cancel a child that is going off-track.
 *
 * Forwarded event types:
 *   tool.call, tool.result, cost.update, status.change, error
 *
 * NOT forwarded (by design):
 *   token — too noisy for the parent's SSE stream
 *   hitl.request — child handles its own human-in-the-loop flow
 *
 * Integration pattern (in lib/spawn-subagent.js):
 *
 *   import { createPipe } from "./subagent-pipe.js";
 *   const pipe = createPipe({
 *     parentSessionId,
 *     childSessionId,
 *     onCancel: () => { // cleanup  },
 *   });
 *   // ... run child loop ...
 *   pipe.close();
 *
 * @module subagent-pipe
 */

import { getAgentRunEmitter, publishAgentRunEvent } from "./agent-run-stream.js";
import { cancelAgentSessionRun } from "./agent-run-control.js";

/** Event types that are forwarded from child to parent. */
const FORWARDED_TYPES = new Set([
  "tool.call",
  "tool.result",
  "cost.update",
  "status.change",
  "error",
]);

/**
 * @typedef {Object} PipeHandle
 * @property {(reason?: string) => void} cancel  Cancel the child run and
 *   publish `subagent.cancelled` on the parent emitter.
 * @property {() => void} close  Unsubscribe from the child emitter; no
 *   further events will be forwarded.
 * @property {boolean} closed  Whether the pipe has been closed.
 */

/**
 * Create a real-time message pipe from a child agent session to its parent.
 *
 * @param {{
 *   parentSessionId: string,
 *   childSessionId: string,
 *   onEvent?: (type: string, payload: object) => void,
 *   onCancel?: () => void,
 * }} opts
 * @returns {PipeHandle}
 */
export function createPipe(opts) {
  const parentSessionId = String(opts?.parentSessionId || "").trim();
  const childSessionId = String(opts?.childSessionId || "").trim();

  if (!parentSessionId) throw new Error("parentSessionId is required");
  if (!childSessionId) throw new Error("childSessionId is required");

  const onEvent = typeof opts?.onEvent === "function" ? opts.onEvent : null;
  const onCancel = typeof opts?.onCancel === "function" ? opts.onCancel : null;

  // Lazily create the child emitter so events can be received even if the
  // child loop hasn't started publishing yet.
  const childEmitter = getAgentRunEmitter(childSessionId);

  let closed = false;

  /**
   * Listener attached to the child's emitter "event" channel.
   * @param {{ type: string, payload?: object }} ev
   */
  function onChildEvent(ev) {
    if (closed || !ev || !ev.type) return;

    const type = String(ev.type);

    // Auto-close on child `done` event.
    if (type === "done") {
      close();
      return;
    }

    // Only forward the allow-listed event types.
    if (!FORWARDED_TYPES.has(type)) return;

    // Publish onto the parent's emitter as a namespaced `subagent.event`.
    publishAgentRunEvent(parentSessionId, "subagent.event", {
      childSessionId,
      originalType: type,
      payload: ev.payload || {},
    });

    // Invoke the caller-supplied callback (if any).
    if (onEvent) {
      try {
        onEvent(type, ev.payload || {});
      } catch (_) {
        /* caller error is swallowed — pipe must stay robust */
      }
    }
  }

  childEmitter.on("event", onChildEvent);

  /**
   * Cancel the child agent run and notify the parent.
   * @param {string} [reason]
   */
  function cancel(reason) {
    cancelAgentSessionRun(childSessionId);

    publishAgentRunEvent(parentSessionId, "subagent.cancelled", {
      childSessionId,
      reason: reason || "cancelled by parent",
    });

    if (onCancel) {
      try {
        onCancel();
      } catch (_) {
        /* caller error is swallowed */
      }
    }
  }

  /**
   * Unsubscribe from the child emitter — no further events will be forwarded.
   */
  function close() {
    if (closed) return;
    closed = true;
    try {
      childEmitter.off("event", onChildEvent);
    } catch (_) {
      /* ignore */
    }
  }

  return {
    cancel,
    close,
    get closed() {
      return closed;
    },
  };
}
