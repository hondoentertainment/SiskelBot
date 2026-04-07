/**
 * Phase 33: Real-Time Sync & Presence
 * WebSocket server for live notifications, optional presence (online users per workspace).
 * Uses one-time tokens for auth; tokens created via GET /api/ws-token.
 *
 * Optional Redis pub/sub for multi-instance deployments (set REDIS_URL env var).
 */
import { randomUUID } from "crypto";
import { WebSocketServer } from "ws";
import { createRedisAdapter } from "./realtime-redis.js";
import { createCollaborationSession, getCollaborationSession } from "./collaboration.js";

const WS_PATH = "/ws";
const TOKEN_TTL_MS = 60_000; // 1 min
const PRESENCE_TTL_MS = 90_000; // 90s - consider user offline after 90s without heartbeat
const INSTANCE_ID = randomUUID();

/** @type {Awaited<ReturnType<typeof createRedisAdapter>>} */
let redisAdapter = null;

/** @type {Map<string, Map<string, { userId: string, displayName?: string, lastSeen: number }>>} remote presence from other instances: workspaceId -> `instanceId:connId` -> entry */
const remotePresence = new Map();

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
 * When Redis is enabled, also publishes to Redis so other instances relay the message.
 */
export function broadcast(userId, workspaceId, payload) {
  sendToLocalClients(userId, workspaceId, payload);
  if (redisAdapter) {
    redisAdapter.publishWorkspace(sanitizeWorkspace(workspaceId), {
      origin: INSTANCE_ID,
      targetUserId: sanitizeUserId(userId),
      targetWorkspaceId: sanitizeWorkspace(workspaceId),
      kind: "broadcast",
      payload,
    });
  }
}

function sendToLocalClients(userId, workspaceId, payload) {
  const key = connKey(userId, workspaceId);
  const set = connections.get(key);
  if (!set || set.size === 0) return;
  const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
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
 * Broadcast to all connections in a workspace (including sender).
 * When Redis is enabled, also publishes so other instances relay to their local connections.
 */
function broadcastToWorkspace(workspaceId, payload) {
  const wsId = sanitizeWorkspace(workspaceId);
  const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
  for (const [key, set] of connections.entries()) {
    const idx = key.lastIndexOf(":");
    const wid = key.slice(idx + 1);
    if (wid !== wsId) continue;
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
  if (redisAdapter) {
    redisAdapter.publishWorkspace(wsId, {
      origin: INSTANCE_ID,
      targetWorkspaceId: wsId,
      kind: "workspaceBroadcastAll",
      payload,
    });
  }
}

/**
 * Broadcast to all connections in workspace except excludeUserId (e.g. typing - don't echo to sender).
 * When Redis is enabled, also publishes so other instances relay to their local connections.
 */
function broadcastToWorkspaceExceptUser(workspaceId, excludeUserId, payload) {
  sendToLocalWorkspaceExceptUser(workspaceId, excludeUserId, payload);
  if (redisAdapter) {
    redisAdapter.publishWorkspace(sanitizeWorkspace(workspaceId), {
      origin: INSTANCE_ID,
      excludeUserId: sanitizeUserId(excludeUserId),
      targetWorkspaceId: sanitizeWorkspace(workspaceId),
      kind: "workspaceBroadcast",
      payload,
    });
  }
}

function sendToLocalWorkspaceExceptUser(workspaceId, excludeUserId, payload) {
  const wsId = sanitizeWorkspace(workspaceId);
  const exclude = sanitizeUserId(excludeUserId);
  const msg = typeof payload === "string" ? payload : JSON.stringify(payload);
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
  if (redisAdapter) {
    redisAdapter.publishPresence({
      instanceId: INSTANCE_ID,
      action: "update",
      workspaceId,
      userId,
      connId,
      displayName: displayName || userId,
      lastSeen: Date.now(),
    });
  }
}

function removePresence(workspaceId, connId) {
  const map = presence.get(workspaceId);
  if (map) {
    map.delete(connId);
    if (map.size === 0) presence.delete(workspaceId);
  }
  if (redisAdapter) {
    redisAdapter.publishPresence({
      instanceId: INSTANCE_ID,
      action: "remove",
      workspaceId,
      connId,
    });
  }
}

/**
 * Phase 36: Get total active WebSocket connections (for Prometheus siskelbot_active_connections).
 */
export function getActiveConnectionCount() {
  let n = 0;
  for (const set of connections.values()) {
    for (const ws of set) {
      if (ws.readyState === 1) n++;
    }
  }
  return n;
}

/**
 * List online users for a workspace (local instance only, TTL-based).
 */
export function getOnlineUsers(workspaceId) {
  const wsId = sanitizeWorkspace(workspaceId);
  return collectPresenceFromMap(presence, wsId);
}

/**
 * List online users for a workspace including remote instances connected via Redis.
 * Falls back to local-only when Redis is not configured.
 */
export function getGlobalOnlineUsers(workspaceId) {
  const wsId = sanitizeWorkspace(workspaceId);
  const localUsers = collectPresenceFromMap(presence, wsId);
  if (!redisAdapter) return localUsers;
  const remoteUsers = collectPresenceFromMap(remotePresence, wsId);
  const seen = new Set(localUsers.map((u) => u.userId));
  for (const ru of remoteUsers) {
    if (!seen.has(ru.userId)) {
      localUsers.push(ru);
      seen.add(ru.userId);
    }
  }
  return localUsers;
}

function collectPresenceFromMap(presenceMap, workspaceId) {
  const map = presenceMap.get(workspaceId);
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
  if (map.size === 0) presenceMap.delete(workspaceId);
  return result;
}

/**
 * Initialize Redis adapter if REDIS_URL is set. Called automatically by attachToServer,
 * but can be called independently for testing.
 */
export async function initRedis(redisUrl) {
  if (redisAdapter) return redisAdapter;
  if (!redisUrl) return null;
  redisAdapter = await createRedisAdapter(redisUrl);
  if (redisAdapter) {
    await redisAdapter.subscribePresence((data) => {
      if (data.instanceId === INSTANCE_ID) return;
      handleRemotePresence(data);
    });
  }
  return redisAdapter;
}

function handleRemotePresence(data) {
  const { instanceId, action, workspaceId, connId, userId, displayName, lastSeen } = data;
  const remoteKey = `${instanceId}:${connId}`;
  if (action === "update") {
    let map = remotePresence.get(workspaceId);
    if (!map) {
      map = new Map();
      remotePresence.set(workspaceId, map);
    }
    map.set(remoteKey, { userId, displayName: displayName || userId, lastSeen: lastSeen || Date.now() });
  } else if (action === "remove") {
    const map = remotePresence.get(workspaceId);
    if (map) {
      map.delete(remoteKey);
      if (map.size === 0) remotePresence.delete(workspaceId);
    }
  }
}

function handleRedisWorkspaceMessage(msg) {
  if (msg.origin === INSTANCE_ID) return;
  if (msg.kind === "broadcast") {
    sendToLocalClients(msg.targetUserId, msg.targetWorkspaceId, msg.payload);
  } else if (msg.kind === "workspaceBroadcast") {
    sendToLocalWorkspaceExceptUser(msg.targetWorkspaceId, msg.excludeUserId, msg.payload);
  } else if (msg.kind === "workspaceBroadcastAll") {
    broadcastToWorkspace(msg.targetWorkspaceId, msg.payload);
  }
}

/** Track which workspace channels we've subscribed to via Redis */
const subscribedWorkspaces = new Set();

async function ensureRedisWorkspaceSubscription(workspaceId) {
  if (!redisAdapter || subscribedWorkspaces.has(workspaceId)) return;
  subscribedWorkspaces.add(workspaceId);
  await redisAdapter.subscribeWorkspace(workspaceId, handleRedisWorkspaceMessage);
}

/**
 * Attach WebSocket server to HTTP server. Call when not on Vercel.
 */
export function attachToServer(httpServer) {
  if (wss) return;
  initRedis(process.env.REDIS_URL);
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
    ensureRedisWorkspaceSubscription(sanitizeWorkspace(workspaceId));

    // Wire up collaboration broadcast for this workspace
    const collabSession = createCollaborationSession(workspaceId);
    collabSession.setBroadcast((message, excludeUserId) => {
      if (excludeUserId) {
        broadcastToWorkspaceExceptUser(workspaceId, excludeUserId, message);
      } else {
        broadcastToWorkspace(workspaceId, message);
      }
    });

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
        // Collaboration events
        if (msg.type === "cursor_update" && msg.position) {
          collabSession.updateCursor(userId, msg.position);
        }
        if (msg.type === "typing_indicator" && msg.typing !== undefined) {
          collabSession.setTyping(userId, msg.typing);
        }
        if (msg.type === "lock_document" && msg.docId) {
          const result = collabSession.lockDocument(userId, msg.docId);
          ws.send(JSON.stringify({ type: "lock_result", docId: msg.docId, ...result }));
        }
        if (msg.type === "unlock_document" && msg.docId) {
          const result = collabSession.unlockDocument(userId, msg.docId);
          ws.send(JSON.stringify({ type: "unlock_result", docId: msg.docId, ...result }));
        }
        if (msg.type === "record_activity" && msg.action) {
          collabSession.recordActivity(userId, msg.action, msg.details);
        }
      } catch (_) {}
    });

    ws.on("close", () => {
      removeConnection(userId, workspaceId, ws);
      removePresence(workspaceId, connId);
      const session = getCollaborationSession(workspaceId);
      if (session) session.removeUser(userId);
    });

    ws.on("error", () => {
      removeConnection(userId, workspaceId, ws);
      removePresence(workspaceId, connId);
      const session = getCollaborationSession(workspaceId);
      if (session) session.removeUser(userId);
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
export async function closeServer() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (redisAdapter) {
    try {
      await redisAdapter.close();
    } catch {}
    redisAdapter = null;
    subscribedWorkspaces.clear();
    remotePresence.clear();
  }
  if (wss) {
    await new Promise((resolve) => {
      wss.close(() => {
        wss = null;
        resolve();
      });
    });
  }
}
