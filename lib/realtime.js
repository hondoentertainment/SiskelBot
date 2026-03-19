/**
 * Phase 33: Real-Time Sync & Presence
 * WebSocket server for live notifications, optional presence (online users per workspace).
 * Uses one-time tokens for auth; tokens created via GET /api/ws-token.
 */
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";

const WS_PATH = "/ws";
const TOKEN_TTL_MS = 60_000; // 1 min
const PRESENCE_TTL_MS = 90_000; // 90s - consider user offline after 90s without heartbeat

/** @type {Map<string, { userId: string, workspaceId: string, expiresAt: number }>} */
const tokenStore = new Map();

/** @type {Map<string, Set<WebSocket>>} key = `${userId}:${workspaceId}` */
const connections = new Map();

/** @type {Map<string, Map<string, { userId: string, displayName?: string, lastSeen: number }>>} workspaceId -> connId -> presence */
const presence = new Map();

/** @type {WebSocket.Server|null} */
let wss = null;

function sanitizeUserId(uid) {
  if (typeof uid !== "string" || !String(uid).trim()) return "anonymous";
  return String(uid).trim().slice(0, 100).replace(/[^a-zA-Z0-9._-]/g, "") || "anonymous";
}

function sanitizeWorkspace(ws) {
  if (typeof ws !== "string" || !String(ws).trim()) return "default";
  return String(ws).trim().slice(0, 50).replace(/[^a-zA-Z0-9._-]/g, "") || "default";
}

/**
 * Create a one-time token for WebSocket connection. Valid for TOKEN_TTL_MS.
 */
export function createToken(userId, workspaceId) {
  const uid = sanitizeUserId(userId);
  const ws = sanitizeWorkspace(workspaceId);
  const token = randomUUID();
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  tokenStore.set(token, { userId: uid, workspaceId: ws, expiresAt });
  const baseUrl = process.env.BASE_URL;
  let wsUrl;
  if (baseUrl) {
    const u = new URL(baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = WS_PATH;
    u.search = `?token=${token}&workspace=${encodeURIComponent(ws)}`;
    wsUrl = u.toString();
  } else {
    const protocol = process.env.NODE_ENV === "production" ? "wss" : "ws";
    const host = process.env.WS_HOST || "localhost";
    const port = process.env.PORT || 3000;
    wsUrl = `${protocol}://${host}:${port}${WS_PATH}?token=${token}&workspace=${encodeURIComponent(ws)}`;
  }
  return { token, url: wsUrl };
}

/**
 * Consume token (one-time use). Returns { userId, workspaceId } or null if invalid.
 */
export function consumeToken(token) {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  tokenStore.delete(token);
  if (Date.now() > entry.expiresAt) return null;
  return { userId: entry.userId, workspaceId: entry.workspaceId };
}

function connKey(userId, workspaceId) {
  return `${sanitizeUserId(userId)}:${sanitizeWorkspace(workspaceId)}`;
}

/**
 * Broadcast payload to all connected clients for userId+workspaceId.
 */
export function broadcast(userId, workspaceId, payload) {
  const key = connKey(userId, workspaceId);
  const set = connections.get(key);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) {
      try {
        ws.send(msg);
      } catch (e) {
        console.warn("[realtime] send error:", e.message);
      }
    }
  }
}

/**
 * Broadcast to all connections in workspace except excludeUserId (e.g. typing - don't echo to sender).
 */
function broadcastToWorkspaceExceptUser(workspaceId, excludeUserId, payload) {
  const wsId = sanitizeWorkspace(workspaceId);
  const exclude = sanitizeUserId(excludeUserId);
  const msg = JSON.stringify(payload);
  for (const [key, set] of connections.entries()) {
    const idx = key.lastIndexOf(":");
    const uid = key.slice(0, idx);
    const wid = key.slice(idx + 1);
    if (wid !== wsId || uid === exclude) continue;
    for (const sock of set) {
      if (sock.readyState === 1) {
        try {
          sock.send(msg);
        } catch (e) {
          console.warn("[realtime] send error:", e.message);
        }
      }
    }
  }
}

/**
 * Broadcast notification to clients. Called by notifications module when a notification is created.
 */
export function broadcastNotification(userId, workspaceId, notification) {
  broadcast(userId, workspaceId, {
    type: "notification",
    notification: {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      createdAt: notification.createdAt,
      read: notification.read,
    },
  });
}

function addConnection(userId, workspaceId, ws) {
  const key = connKey(userId, workspaceId);
  let set = connections.get(key);
  if (!set) {
    set = new Set();
    connections.set(key, set);
  }
  set.add(ws);
}

function removeConnection(userId, workspaceId, ws) {
  const key = connKey(userId, workspaceId);
  const set = connections.get(key);
  if (set) {
    set.delete(ws);
    if (set.size === 0) connections.delete(key);
  }
}

function updatePresence(workspaceId, userId, connId, displayName) {
  let map = presence.get(workspaceId);
  if (!map) {
    map = new Map();
    presence.set(workspaceId, map);
  }
  map.set(connId, {
    userId,
    displayName: displayName || userId,
    lastSeen: Date.now(),
  });
}

function removePresence(workspaceId, connId) {
  const map = presence.get(workspaceId);
  if (map) {
    map.delete(connId);
    if (map.size === 0) presence.delete(workspaceId);
  }
}

/**
 * List online users for a workspace (in-memory, TTL-based).
 */
export function getOnlineUsers(workspaceId) {
  const map = presence.get(sanitizeWorkspace(workspaceId));
  if (!map) return [];
  const now = Date.now();
  const result = [];
  for (const [connId, entry] of map.entries()) {
    if (now - entry.lastSeen < PRESENCE_TTL_MS) {
      result.push({ userId: entry.userId, displayName: entry.displayName });
    } else {
      map.delete(connId);
    }
  }
  if (map.size === 0) presence.delete(sanitizeWorkspace(workspaceId));
  return result;
}

/**
 * Attach WebSocket server to HTTP server. Call when not on Vercel.
 */
export function attachToServer(httpServer) {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    const workspace = url.searchParams.get("workspace");
    if (!token || !workspace) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const parsed = consumeToken(token);
    if (!parsed || parsed.workspaceId !== sanitizeWorkspace(workspace)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, parsed);
    });
  });

  wss.on("connection", (ws, req, parsed) => {
    const { userId, workspaceId } = parsed;
    const connId = randomUUID();
    addConnection(userId, workspaceId, ws);
    updatePresence(workspaceId, userId, connId);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === "heartbeat") {
          updatePresence(workspaceId, userId, connId, msg.displayName);
          ws.send(JSON.stringify({ type: "heartbeat_ack" }));
        }
        if (msg.type === "typing" && msg.typing !== undefined) {
          broadcastToWorkspaceExceptUser(workspaceId, userId, { type: "typing", userId, typing: msg.typing });
        }
      } catch (_) {}
    });

    ws.on("close", () => {
      removeConnection(userId, workspaceId, ws);
      removePresence(workspaceId, connId);
    });

    ws.on("error", () => {
      removeConnection(userId, workspaceId, ws);
      removePresence(workspaceId, connId);
    });
  });
}

/**
 * Clean expired tokens periodically.
 */
function cleanupTokens() {
  const now = Date.now();
  for (const [token, entry] of tokenStore.entries()) {
    if (now > entry.expiresAt) tokenStore.delete(token);
  }
}
// unref() so unit tests and one-off scripts can exit; HTTP server keeps the live process alive.
let cleanupInterval = setInterval(cleanupTokens, 30_000).unref();

/**
 * Phase 34: Close WebSocket server for graceful shutdown.
 * Returns a Promise that resolves when the server is fully closed.
 */
export function closeServer() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (wss) {
    return new Promise((resolve) => {
      wss.close(() => {
        wss = null;
        resolve();
      });
    });
  }
  return Promise.resolve();
}
