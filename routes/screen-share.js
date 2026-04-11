/**
 * Phase 41.5: Screen-share REST API.
 *
 * Manages WebRTC screen-share rooms over the global signaling registry.
 * The actual signaling messages (offer/answer/ICE) flow over the existing
 * WebSocket channel; these REST endpoints handle room metadata, discovery,
 * and lifecycle.
 *
 * Routes:
 *   POST   /api/v1/screen-share/rooms              create a new room
 *   GET    /api/v1/screen-share/rooms              list active rooms in workspace
 *   GET    /api/v1/screen-share/rooms/:id          get room info + participants
 *   POST   /api/v1/screen-share/rooms/:id/join     join a room as viewer
 *   DELETE /api/v1/screen-share/rooms/:id          close a room (host or admin)
 */
import { globalSignaling } from "../lib/webrtc-signaling.js";

export function mountScreenShareRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    sanitizeWorkspace,
  } = deps;

  // POST /api/v1/screen-share/rooms
  apiRoute(
    "post",
    "/screen-share/rooms",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    (req, res) => {
      try {
        const sessionId = String(req.body?.sessionId || "").trim();
        if (!sessionId) {
          return apiError(
            res,
            400,
            "VALIDATION_ERROR",
            "sessionId is required",
            "Provide the WebSocket session id of the host."
          );
        }
        const workspaceId = sanitizeWorkspace(req.body?.workspaceId || req.workspace || "default");
        const title = typeof req.body?.title === "string" ? req.body.title.slice(0, 200) : "Screen share";
        const userId = req.userId || "anonymous";
        const room = globalSignaling.createRoom(req.body?.roomId || null, sessionId, {
          workspaceId,
          hostUserId: userId,
          title,
        });
        res.status(201).json({ _version: 1, room });
      } catch (err) {
        if (/already exists/i.test(err.message)) {
          return apiError(res, 409, "CONFLICT", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBRTC.md.");
      }
    }
  );

  // GET /api/v1/screen-share/rooms
  apiRoute(
    "get",
    "/screen-share/rooms",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    (req, res) => {
      try {
        const workspaceId = sanitizeWorkspace(req.query.workspaceId || req.workspace || "default");
        const rooms = globalSignaling.listRooms(workspaceId);
        res.json({ _version: 1, workspaceId, items: rooms, count: rooms.length });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBRTC.md.");
      }
    }
  );

  // GET /api/v1/screen-share/rooms/:id
  apiRoute(
    "get",
    "/screen-share/rooms/:id",
    storageRateLimiter,
    userAuth,
    requireScope("read"),
    logRequest,
    (req, res) => {
      try {
        const roomId = String(req.params.id || "").trim();
        const room = globalSignaling.getRoom(roomId);
        if (!room) {
          return apiError(res, 404, "NOT_FOUND", `Room ${roomId} not found`);
        }
        const participants = globalSignaling.getRoomParticipants(roomId);
        res.json({ _version: 1, room, participants });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBRTC.md.");
      }
    }
  );

  // POST /api/v1/screen-share/rooms/:id/join
  apiRoute(
    "post",
    "/screen-share/rooms/:id/join",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    (req, res) => {
      try {
        const roomId = String(req.params.id || "").trim();
        const sessionId = String(req.body?.sessionId || "").trim();
        if (!sessionId) {
          return apiError(
            res,
            400,
            "VALIDATION_ERROR",
            "sessionId is required",
            "Provide the WebSocket session id of the joining viewer."
          );
        }
        const userId = req.userId || "anonymous";
        const room = globalSignaling.joinRoom(roomId, sessionId, { userId });
        res.json({ _version: 1, room });
      } catch (err) {
        if (/not found/i.test(err.message)) {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBRTC.md.");
      }
    }
  );

  // DELETE /api/v1/screen-share/rooms/:id
  apiRoute(
    "delete",
    "/screen-share/rooms/:id",
    storageRateLimiter,
    userAuth,
    requireScope("write"),
    logRequest,
    (req, res) => {
      try {
        const roomId = String(req.params.id || "").trim();
        const room = globalSignaling.getRoom(roomId);
        if (!room) {
          return apiError(res, 404, "NOT_FOUND", `Room ${roomId} not found`);
        }
        // Only the host or an admin can close a room.
        const userId = req.userId || "anonymous";
        if (room.hostUserId !== userId && !req.isAdmin) {
          return apiError(res, 403, "FORBIDDEN", "Only the host can close this room");
        }
        globalSignaling.closeRoom(roomId, "deleted");
        res.json({ _version: 1, ok: true, roomId });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/WEBRTC.md.");
      }
    }
  );
}

export default mountScreenShareRoutes;
