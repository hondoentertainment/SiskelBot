/**
 * Unified realtime WebSocket route.
 *
 * Mounts a WebSocketServer at /ws/realtime that multiplexes typed
 * channels (chat, runs, workspace presence, etc.) over a single
 * connection per tab. Uses lib/realtime-channels.js for in-memory
 * fan-out and resume tokens.
 *
 * Protocol:
 *   Client -> Server:
 *     { type: "subscribe",   channel: string, sinceSeq?: number }
 *     { type: "unsubscribe", channel: string }
 *     { type: "ping" }
 *
 *   Server -> Client:
 *     { type: "event", channel, seq, payload, ts }
 *     { type: "ack",   channel }
 *     { type: "pong" }
 *     { type: "error", code, message }
 *
 * Auth: accepts the existing session cookie or a ?token= query param.
 * When neither is present and auth is configured, the upgrade is
 * rejected with 401. The token lookup reuses the one-time token store
 * from lib/realtime.js (consumeToken) so it interoperates with the
 * existing /api/ws-token endpoint.
 */

import { randomUUID } from "crypto";
import { createRequire } from "module";
import {
  CLIENT_SUBSCRIBE,
  CLIENT_UNSUBSCRIBE,
  CLIENT_PING,
  SERVER_EVENT,
  SERVER_ACK,
  SERVER_PONG,
  SERVER_ERROR,
  ERR_UNAUTHENTICATED,
  ERR_BAD_MESSAGE,
  ERR_INVALID_CHANNEL,
} from "../client/src/realtime/events.js";

const WS_PATH = "/ws/realtime";

/**
 * Best-effort minimal auth resolver. Prefers the injected deps.auth.resolve
 * (tests and future wiring can supply it), then falls back to the one-time
 * token store from lib/realtime.js, then to the `anonymous` user when no
 * auth is configured. Mirrors the existing userAuth convention in
 * routes/agent-sessions.js (session cookie or bearer token).
 *
 * TODO(server.js wiring): when mounting, pass deps.resolveWsAuth that
 * inspects the session cookie via the shared session middleware. The
 * cookie parser is attached to HTTP requests, not WS upgrade requests,
 * so the real wiring may need to decode the session cookie manually via
 * express-session's store. Until then, clients should pass ?token= from
 * GET /api/ws-token.
 */
async function resolveAuth(request, deps) {
  if (deps && typeof deps.resolveWsAuth === "function") {
    // When an explicit resolver is provided, its decision is final.
    // Returning null/falsy means "reject" — do not fall through to
    // the anonymous fallback, as that would silently bypass auth.
    try {
      const got = await deps.resolveWsAuth(request);
      return (got && got.userId) ? got : null;
    } catch {
      return null;
    }
  }

  // Fallback: one-time token from lib/realtime.js
  try {
    const url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
    const token = url.searchParams.get("token");
    if (token) {
      const mod = await import("../lib/realtime.js").catch(() => null);
      if (mod && typeof mod.consumeToken === "function") {
        const parsed = mod.consumeToken(token);
        if (parsed && parsed.userId) {
          return { userId: parsed.userId, workspaceId: parsed.workspaceId || "default" };
        }
      }
    }
  } catch {
    // ignore
  }

  // If auth isn't configured at all, allow as anonymous. This matches
  // lib/auth.js userAuth semantics.
  try {
    const authMod = await import("../lib/auth.js").catch(() => null);
    if (authMod && typeof authMod.isAuthConfigured === "function" && !authMod.isAuthConfigured()) {
      return { userId: "anonymous", workspaceId: "default" };
    }
  } catch {
    // ignore
  }

  return null;
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  } catch {
    // socket may have closed between checks; ignore
  }
}

function isValidChannelId(channel) {
  return (
    typeof channel === "string" &&
    channel.length > 0 &&
    channel.length <= 200 &&
    /^[a-zA-Z0-9._:\-/]+$/.test(channel)
  );
}

/**
 * Mount the unified realtime WebSocket handler on an existing http.Server.
 *
 * @param {import("http").Server} httpServer
 * @param {object} deps
 * @param {import("../lib/realtime-channels.js").ChannelRegistry} deps.channels
 * @param {(req: import("http").IncomingMessage) => Promise<{ userId: string, workspaceId?: string } | null>} [deps.resolveWsAuth]
 * @param {object} [deps.logger]
 * @returns {{ close: () => Promise<void>, wss: WebSocketServer, path: string }}
 */
export function mountRealtimeWs(httpServer, deps = {}) {
  const { channels, logger = console } = deps;
  if (!channels || typeof channels.publish !== "function") {
    throw new Error("mountRealtimeWs requires deps.channels (see lib/realtime-channels.js)");
  }

  // Lazy-load `ws` so bare worktrees (no node_modules) can still import
  // this file — the handler only activates when actually mounted.
  let WebSocketServer;
  try {
    const req = createRequire(import.meta.url);
    ({ WebSocketServer } = req("ws"));
  } catch (err) {
    throw new Error(
      "mountRealtimeWs: the `ws` package is required but not installed. Run `npm install ws`.",
      { cause: err },
    );
  }

  const wss = new WebSocketServer({ noServer: true });

  const upgradeHandler = async (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== WS_PATH) return; // let other handlers take it

    const auth = await resolveAuth(request, deps);
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, auth);
    });
  };

  httpServer.on("upgrade", upgradeHandler);

  wss.on("connection", (ws, _request, auth) => {
    const clientId = randomUUID();
    /** @type {Map<string, () => boolean>} channel -> unsub */
    const subs = new Map();

    const cleanup = () => {
      for (const off of subs.values()) {
        try { off(); } catch { /* ignore */ }
      }
      subs.clear();
      try { channels.unsubscribeAll(clientId); } catch { /* ignore */ }
    };

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        safeSend(ws, { type: SERVER_ERROR, code: ERR_BAD_MESSAGE, message: "invalid JSON" });
        return;
      }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
        safeSend(ws, { type: SERVER_ERROR, code: ERR_BAD_MESSAGE, message: "missing type" });
        return;
      }

      if (msg.type === CLIENT_PING) {
        safeSend(ws, { type: SERVER_PONG });
        return;
      }

      if (msg.type === CLIENT_SUBSCRIBE) {
        const channel = msg.channel;
        if (!isValidChannelId(channel)) {
          safeSend(ws, { type: SERVER_ERROR, code: ERR_INVALID_CHANNEL, message: "invalid channel" });
          return;
        }
        if (subs.has(channel)) {
          // already subscribed — re-ack and ignore
          safeSend(ws, { type: SERVER_ACK, channel });
          return;
        }
        const sinceSeq = Number.isFinite(msg.sinceSeq) ? Number(msg.sinceSeq) : undefined;
        channels.subscribe(
          channel,
          clientId + ":" + channel,
          (ev) => {
            safeSend(ws, {
              type: SERVER_EVENT,
              channel: ev.channel,
              seq: ev.seq,
              payload: ev.payload,
              ts: ev.ts,
            });
          },
          sinceSeq != null ? { sinceSeq } : {},
        );
        subs.set(channel, () => channels.unsubscribe(channel, clientId + ":" + channel));
        safeSend(ws, { type: SERVER_ACK, channel });
        return;
      }

      if (msg.type === CLIENT_UNSUBSCRIBE) {
        const channel = msg.channel;
        if (!isValidChannelId(channel)) {
          safeSend(ws, { type: SERVER_ERROR, code: ERR_INVALID_CHANNEL, message: "invalid channel" });
          return;
        }
        const off = subs.get(channel);
        if (off) {
          try { off(); } catch { /* ignore */ }
          subs.delete(channel);
        }
        safeSend(ws, { type: SERVER_ACK, channel });
        return;
      }

      safeSend(ws, { type: SERVER_ERROR, code: ERR_BAD_MESSAGE, message: `unknown type: ${msg.type}` });
    });

    ws.on("close", cleanup);
    ws.on("error", (err) => {
      try { logger?.warn?.("[realtime-ws] socket error:", err?.message || err); } catch { /* ignore */ }
      cleanup();
    });

    // Informational hello so clients can tell the handler is alive.
    safeSend(ws, { type: SERVER_ACK, channel: "__hello__" });
  });

  const close = async () => {
    try { httpServer.off("upgrade", upgradeHandler); } catch { /* ignore */ }
    await new Promise((resolve) => {
      try {
        wss.close(() => resolve());
      } catch {
        resolve();
      }
    });
  };

  // Keep the auth variable silent to linters — it is used above.
  void ERR_UNAUTHENTICATED;

  return { close, wss, path: WS_PATH };
}

export const REALTIME_WS_PATH = WS_PATH;
