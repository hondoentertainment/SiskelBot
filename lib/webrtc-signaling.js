/**
 * Phase 41.5: WebRTC signaling server for peer-to-peer screen sharing.
 *
 * Hosts and viewers exchange SDP offers/answers and ICE candidates through
 * an in-memory room registry. The signaling layer never proxies media — it
 * only relays small JSON messages so peers can establish a direct connection.
 *
 * A "room" represents a single screen-share session bound to a workspace and
 * a host (the user sharing their screen). Other users join as viewers.
 *
 * Sessions are identified by a sessionId (typically the WebSocket connection
 * id). Rooms are removed automatically when the host leaves or after the
 * last participant disconnects.
 */
import { randomUUID } from "crypto";

/**
 * Create a new signaling server instance.
 *
 * The factory pattern allows tests to instantiate isolated servers without
 * touching shared module-level state.
 */
export function createSignalingServer() {
  /** @type {Map<string, { id: string, workspaceId: string, hostSessionId: string, hostUserId: string, title: string, createdAt: number, participants: Set<string> }>} */
  const rooms = new Map();
  /** @type {Map<string, { roomId: string, userId: string, role: "host"|"viewer", joinedAt: number }>} */
  const sessions = new Map();
  /** @type {Map<string, Array<{ from: string, to: string, kind: string, signal: any, ts: number }>>} sessionId -> queued messages awaiting a transport */
  const inbox = new Map();
  /** @type {Map<string, (msg: any) => void>} sessionId -> transport delivery callback */
  const transports = new Map();

  function deliver(toSession, msg) {
    const fn = transports.get(toSession);
    if (typeof fn === "function") {
      try {
        fn(msg);
        return true;
      } catch (_) {}
    }
    let queue = inbox.get(toSession);
    if (!queue) {
      queue = [];
      inbox.set(toSession, queue);
    }
    queue.push(msg);
    if (queue.length > 200) queue.shift();
    return false;
  }

  /**
   * Register a transport (delivery callback) for a session. Any queued
   * messages are flushed immediately.
   */
  function registerTransport(sessionId, fn) {
    if (!sessionId || typeof fn !== "function") return;
    transports.set(sessionId, fn);
    const queue = inbox.get(sessionId);
    if (queue && queue.length) {
      for (const msg of queue) {
        try {
          fn(msg);
        } catch (_) {}
      }
      inbox.delete(sessionId);
    }
  }

  function unregisterTransport(sessionId) {
    transports.delete(sessionId);
  }

  /**
   * Create a new screen-share room hosted by hostSessionId.
   * @returns {{ id: string, workspaceId: string, hostSessionId: string, hostUserId: string, title: string, createdAt: number, participants: string[] }}
   */
  function createRoom(roomId, hostSessionId, opts = {}) {
    if (!hostSessionId) throw new Error("hostSessionId is required");
    const id = roomId || randomUUID();
    if (rooms.has(id)) throw new Error(`Room ${id} already exists`);
    const room = {
      id,
      workspaceId: String(opts.workspaceId || "default"),
      hostSessionId,
      hostUserId: String(opts.hostUserId || "anonymous"),
      title: String(opts.title || "Screen share").slice(0, 200),
      createdAt: Date.now(),
      participants: new Set([hostSessionId]),
    };
    rooms.set(id, room);
    sessions.set(hostSessionId, {
      roomId: id,
      userId: room.hostUserId,
      role: "host",
      joinedAt: Date.now(),
    });
    return serializeRoom(room);
  }

  /**
   * Add a viewer session to an existing room. Notifies the host so it can
   * initiate a WebRTC offer to the new viewer.
   */
  function joinRoom(roomId, sessionId, opts = {}) {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`Room ${roomId} not found`);
    if (sessions.has(sessionId) && sessions.get(sessionId).roomId !== roomId) {
      // Force-leave any prior room before joining this one.
      leaveRoom(sessionId);
    }
    room.participants.add(sessionId);
    const userId = String(opts.userId || "anonymous");
    sessions.set(sessionId, {
      roomId,
      userId,
      role: sessionId === room.hostSessionId ? "host" : "viewer",
      joinedAt: Date.now(),
    });
    // Notify other participants of the new peer
    for (const peer of room.participants) {
      if (peer === sessionId) continue;
      deliver(peer, {
        type: "peer_joined",
        roomId,
        sessionId,
        userId,
      });
    }
    return serializeRoom(room);
  }

  /**
   * Remove a session from its room. If the host leaves, the entire room
   * is closed and all viewers are notified.
   */
  function leaveRoom(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    sessions.delete(sessionId);
    const room = rooms.get(session.roomId);
    if (!room) return null;

    if (sessionId === room.hostSessionId) {
      // Host leaving collapses the room.
      for (const peer of room.participants) {
        if (peer === sessionId) continue;
        deliver(peer, {
          type: "screen_share_ended",
          roomId: room.id,
          reason: "host_left",
        });
        const peerSession = sessions.get(peer);
        if (peerSession) sessions.delete(peer);
      }
      rooms.delete(room.id);
      return { roomClosed: true, roomId: room.id };
    }

    room.participants.delete(sessionId);
    for (const peer of room.participants) {
      deliver(peer, {
        type: "peer_left",
        roomId: room.id,
        sessionId,
        userId: session.userId,
      });
    }
    if (room.participants.size === 0) {
      rooms.delete(room.id);
      return { roomClosed: true, roomId: room.id };
    }
    return { roomClosed: false, roomId: room.id };
  }

  /**
   * Relay a WebRTC signaling message (offer / answer / ICE candidate)
   * from one session to another within the same room.
   */
  function handleSignal(fromSession, toSession, signal) {
    const sender = sessions.get(fromSession);
    const recipient = sessions.get(toSession);
    if (!sender) throw new Error(`Unknown sender session ${fromSession}`);
    if (!recipient) throw new Error(`Unknown recipient session ${toSession}`);
    if (sender.roomId !== recipient.roomId) {
      throw new Error("Sessions are not in the same room");
    }
    if (!signal || typeof signal !== "object") {
      throw new Error("signal must be an object");
    }
    const kind = String(signal.type || signal.kind || "signal");
    const message = {
      type: "webrtc_signal",
      kind,
      roomId: sender.roomId,
      from: fromSession,
      fromUserId: sender.userId,
      to: toSession,
      signal,
      ts: Date.now(),
    };
    deliver(toSession, message);
    return message;
  }

  /**
   * List participant info for a room.
   */
  function getRoomParticipants(roomId) {
    const room = rooms.get(roomId);
    if (!room) return [];
    const result = [];
    for (const sid of room.participants) {
      const s = sessions.get(sid);
      if (!s) continue;
      result.push({
        sessionId: sid,
        userId: s.userId,
        role: s.role,
        joinedAt: s.joinedAt,
      });
    }
    return result;
  }

  /**
   * List all active rooms (optionally filtered by workspaceId).
   */
  function listRooms(workspaceId) {
    const result = [];
    for (const room of rooms.values()) {
      if (workspaceId && room.workspaceId !== workspaceId) continue;
      result.push(serializeRoom(room));
    }
    return result;
  }

  function getRoom(roomId) {
    const room = rooms.get(roomId);
    return room ? serializeRoom(room) : null;
  }

  /**
   * Force-close a room and notify all participants. Used by hosts and admins.
   */
  function closeRoom(roomId, reason = "closed") {
    const room = rooms.get(roomId);
    if (!room) return false;
    for (const peer of room.participants) {
      deliver(peer, {
        type: "screen_share_ended",
        roomId,
        reason,
      });
      sessions.delete(peer);
    }
    rooms.delete(roomId);
    return true;
  }

  function serializeRoom(room) {
    return {
      id: room.id,
      workspaceId: room.workspaceId,
      hostSessionId: room.hostSessionId,
      hostUserId: room.hostUserId,
      title: room.title,
      createdAt: room.createdAt,
      participants: Array.from(room.participants),
      participantCount: room.participants.size,
    };
  }

  /**
   * Internal helpers exposed for tests / inspection.
   */
  function _stats() {
    return {
      rooms: rooms.size,
      sessions: sessions.size,
      transports: transports.size,
      queued: Array.from(inbox.values()).reduce((n, q) => n + q.length, 0),
    };
  }

  return {
    createRoom,
    joinRoom,
    leaveRoom,
    handleSignal,
    getRoomParticipants,
    listRooms,
    getRoom,
    closeRoom,
    registerTransport,
    unregisterTransport,
    _stats,
  };
}

/**
 * Default singleton used by routes and the WebSocket integration.
 */
export const globalSignaling = createSignalingServer();
