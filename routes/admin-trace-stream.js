/**
 * Admin live trace SSE stream route.
 *
 * Exposes GET /api/admin/traces/:sessionId/stream — opens a Server-Sent
 * Events connection and forwards every event published onto the in-memory
 * agent-run emitter (lib/agent-run-stream.js) for that session id.
 *
 * Meant for ops to watch an active agent run in real time (tool calls,
 * status changes, done/error signals). Consumes the existing emitter via
 * `getAgentRunEmitter` — does NOT build a parallel channel.
 *
 * Auth: admin-scoped. Because EventSource cannot send custom headers, the
 * endpoint also accepts the admin key via `?key=...` query param. The key
 * is copied into the `x-admin-api-key` header before `adminAuth` runs so
 * the existing middleware approves it. The security trade-off: the key can
 * end up in access logs / referer chains, so this fallback is gated to
 * this endpoint only and callers are encouraged to use a header when they
 * can (e.g. curl).
 *
 * Connection lifecycle:
 *   - initial `event: hello` frame emitted so the client can confirm subscription
 *   - heartbeat `: keepalive` comment every 15s
 *   - hard cap at 1 hour to avoid leaking listeners
 *   - clean teardown on req close / res close / `done` event / error
 */

import { getAgentRunEmitter } from "../lib/agent-run-stream.js";

const HEARTBEAT_MS = 15_000;
const MAX_CONNECTION_MS = 60 * 60 * 1000; // 1 hour
const WAIT_FOR_EMITTER_MS = 500;

/** Strip anything that isn't URL/filesystem-safe from a session id. */
function sanitizeSessionId(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Allow letters, digits, underscore, dash, dot.
  return s.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 128);
}

/**
 * Mount admin live-trace SSE routes.
 *
 * @param {import('express').Express} app
 * @param {{
 *   apiError: (res: any, status: number, code: string, message: string, hint?: string) => any,
 *   logRequest: import('express').RequestHandler,
 *   adminAuth: import('express').RequestHandler,
 *   requireScope: (scope: string) => import('express').RequestHandler,
 *   sanitizeWorkspace?: (s: string) => string,
 * }} deps
 */
export default function mountAdminTraceStreamRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope } = deps;

  // Adapter so EventSource clients can pass the admin key via ?key=...
  // Copies it into `x-admin-api-key` before the real adminAuth runs. The
  // real adminAuth still performs the constant-time comparison.
  function queryKeyToHeader(req, _res, next) {
    const qk = typeof req.query?.key === "string" ? req.query.key.trim() : "";
    if (qk && !req.headers["x-admin-api-key"] && !req.headers.authorization) {
      req.headers["x-admin-api-key"] = qk;
    }
    next();
  }

  app.get(
    "/api/admin/traces/:sessionId/stream",
    queryKeyToHeader,
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      const sessionId = sanitizeSessionId(req.params?.sessionId);
      if (!sessionId) {
        return apiError(res, 400, "INVALID_SESSION_ID", "sessionId is required and must contain safe characters");
      }

      // SSE headers
      try {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();
      } catch (_) { /* ignore */ }

      let ended = false;
      let heartbeatTimer = null;
      let hardCapTimer = null;
      let waitingTimer = null;
      /** @type {import('events').EventEmitter | null} */
      let emitter = null;
      /** @type {((ev: any) => void) | null} */
      let onEvent = null;

      function writeSafe(chunk) {
        if (ended) return false;
        try { return res.write(chunk); } catch (_) { return false; }
      }

      function writeEvent(type, payload) {
        let data;
        try {
          data = JSON.stringify(payload || {});
        } catch (_) {
          data = JSON.stringify({ error: "unserializable_payload" });
        }
        writeSafe(`event: ${type}\ndata: ${data}\n\n`);
      }

      function close() {
        if (ended) return;
        ended = true;
        if (heartbeatTimer) { try { clearInterval(heartbeatTimer); } catch (_) {} heartbeatTimer = null; }
        if (hardCapTimer) { try { clearTimeout(hardCapTimer); } catch (_) {} hardCapTimer = null; }
        if (waitingTimer) { try { clearTimeout(waitingTimer); } catch (_) {} waitingTimer = null; }
        if (emitter && onEvent) {
          try { emitter.off("event", onEvent); } catch (_) {}
        }
        try { res.end(); } catch (_) {}
      }

      // Immediate hello frame so the client can confirm subscription.
      writeSafe(`event: hello\ndata: ${JSON.stringify({ sessionId, ts: Date.now() })}\n\n`);

      // Attach lifecycle handlers.
      req.on("close", close);
      req.on("aborted", close);
      req.on("error", close);
      res.on("close", close);
      res.on("error", close);

      // Heartbeat + hard cap.
      heartbeatTimer = setInterval(() => { writeSafe(": keepalive\n\n"); }, HEARTBEAT_MS);
      if (heartbeatTimer && typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
      hardCapTimer = setTimeout(close, MAX_CONNECTION_MS);
      if (hardCapTimer && typeof hardCapTimer.unref === "function") hardCapTimer.unref();

      // Subscribe to the emitter. getAgentRunEmitter lazily creates one if
      // the run hasn't started yet, so a brief "waiting" event is emitted
      // and we just stay connected — future events will flow through.
      try {
        emitter = getAgentRunEmitter(sessionId);
      } catch (err) {
        writeEvent("error", { message: String(err?.message || err) });
        close();
        return;
      }

      onEvent = (ev) => {
        if (ended || !ev || !ev.type) return;
        writeEvent(ev.type, { ts: Date.now(), payload: ev.payload || {} });
        if (ev.type === "done" || ev.type === "error") {
          // For "done" we close immediately so the client stops reconnecting.
          // For "error" we let the next "done" close things, but if the
          // publisher doesn't follow up we'll still close on disconnect.
          if (ev.type === "done") close();
        }
      };

      emitter.on("event", onEvent);

      // If no listeners seem to be firing quickly, emit a "waiting" event
      // so the client UI can show status instead of a blank panel. We
      // schedule this unconditionally — it's informational only.
      waitingTimer = setTimeout(() => {
        if (!ended) writeEvent("waiting", { sessionId, ts: Date.now() });
      }, WAIT_FOR_EMITTER_MS);
      if (waitingTimer && typeof waitingTimer.unref === "function") waitingTimer.unref();
    },
  );
}
