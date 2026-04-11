/**
 * Phase 49.5: Collaborative VR rooms routes.
 *
 * Multi-user shared VR workspace sessions. These REST endpoints manage
 * durable room state, participants, poses, shared objects, and voice
 * channels. Actual realtime sync is delegated to the existing WebSocket
 * realtime layer.
 *
 * Routes:
 *   POST   /api/v1/vr-rooms                              create a room
 *   GET    /api/v1/vr-rooms                              list rooms
 *   GET    /api/v1/vr-rooms/:id                          get a room
 *   PUT    /api/v1/vr-rooms/:id                          update a room
 *   DELETE /api/v1/vr-rooms/:id                          delete a room
 *   POST   /api/v1/vr-rooms/:id/join                     join a room
 *   POST   /api/v1/vr-rooms/:id/leave                    leave a room
 *   GET    /api/v1/vr-rooms/:id/participants             list participants
 *   POST   /api/v1/vr-rooms/:id/pose                     update self pose
 *   GET    /api/v1/vr-rooms/:id/pose/:participantId      get participant pose
 *   POST   /api/v1/vr-rooms/:id/objects                  spawn an object
 *   PUT    /api/v1/vr-rooms/:id/objects/:objId           update an object
 *   DELETE /api/v1/vr-rooms/:id/objects/:objId           remove an object
 *   GET    /api/v1/vr-rooms/:id/objects                  list objects
 *   POST   /api/v1/vr-rooms/:id/voice                    set voice state
 */
import {
  createRoom,
  getRoom,
  listRooms,
  updateRoom,
  deleteRoom,
  joinRoom,
  leaveRoom,
  getParticipants,
  updateParticipantPose,
  getParticipantPose,
  spawnObject,
  updateObject,
  removeObject,
  getRoomObjects,
  setVoiceState,
} from "../lib/vr-rooms.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/at capacity/i.test(m)) return 409;
  if (/required|must be|is not|invalid/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code =
    status === 404
      ? "NOT_FOUND"
      : status === 409
        ? "CONFLICT"
        : status === 400
          ? "INVALID_INPUT"
          : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "vr-rooms error");
}

export function mountVrRoomsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/vr-rooms
  apiRoute("post", "/vr-rooms", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      const room = await createRoom({
        name: body.name,
        workspaceId: body.workspaceId || req.workspace || "default",
        maxParticipants: body.maxParticipants,
        isPublic: body.isPublic,
        theme: body.theme,
        layout: body.layout,
        ownerId: body.ownerId || req.userId || null,
      });
      return res.status(201).json({ _version: 1, room });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/vr-rooms
  apiRoute("get", "/vr-rooms", log, auth, scope("read"), async (req, res) => {
    try {
      const filter = {};
      if (typeof req.query.workspaceId === "string" && req.query.workspaceId) {
        filter.workspaceId = req.query.workspaceId;
      }
      if (req.query.isPublic === "true") filter.isPublic = true;
      else if (req.query.isPublic === "false") filter.isPublic = false;
      if (typeof req.query.ownerId === "string" && req.query.ownerId) {
        filter.ownerId = req.query.ownerId;
      }
      const rooms = await listRooms(filter);
      return res.json({ _version: 1, rooms, count: rooms.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/vr-rooms/:id
  apiRoute("get", "/vr-rooms/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const room = await getRoom(req.params.id);
      if (!room) {
        return apiError(res, 404, "NOT_FOUND", `room ${req.params.id} not found`);
      }
      return res.json({ _version: 1, room });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // PUT /api/v1/vr-rooms/:id
  apiRoute("put", "/vr-rooms/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const room = await updateRoom(req.params.id, req.body || {});
      return res.json({ _version: 1, room });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/vr-rooms/:id
  apiRoute("delete", "/vr-rooms/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const room = await getRoom(req.params.id);
      if (!room) {
        return apiError(res, 404, "NOT_FOUND", `room ${req.params.id} not found`);
      }
      // Only admin or owner may delete. If no authentication is enforced,
      // auth is a no-op middleware and req.userId will be undefined — in
      // that case we allow deletion (same relaxed behaviour as other routes).
      const actor = req.userId || null;
      if (actor && room.ownerId && actor !== room.ownerId && !req.isAdmin) {
        return apiError(res, 403, "FORBIDDEN", "only the owner or an admin may delete this room");
      }
      const ok = await deleteRoom(req.params.id);
      return res.json({ _version: 1, deleted: ok });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/vr-rooms/:id/join
  apiRoute("post", "/vr-rooms/:id/join", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const userId = body.userId || req.userId || "anonymous";
      const displayName = body.displayName || userId;
      const avatarId = body.avatarId || "default";
      const result = await joinRoom(req.params.id, userId, displayName, avatarId);
      return res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/vr-rooms/:id/leave
  apiRoute("post", "/vr-rooms/:id/leave", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.participantId) {
        return apiError(res, 400, "INVALID_INPUT", "participantId is required");
      }
      const ok = await leaveRoom(req.params.id, body.participantId);
      if (!ok) {
        return apiError(res, 404, "NOT_FOUND", "participant or room not found");
      }
      return res.json({ _version: 1, left: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/vr-rooms/:id/participants
  apiRoute("get", "/vr-rooms/:id/participants", log, auth, scope("read"), async (req, res) => {
    try {
      const room = await getRoom(req.params.id);
      if (!room) {
        return apiError(res, 404, "NOT_FOUND", `room ${req.params.id} not found`);
      }
      const participants = await getParticipants(req.params.id);
      return res.json({ _version: 1, participants, count: participants.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/vr-rooms/:id/pose
  apiRoute("post", "/vr-rooms/:id/pose", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.participantId) {
        return apiError(res, 400, "INVALID_INPUT", "participantId is required");
      }
      const pose = await updateParticipantPose(req.params.id, body.participantId, body.pose || {});
      return res.json({ _version: 1, pose });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/vr-rooms/:id/pose/:participantId
  apiRoute(
    "get",
    "/vr-rooms/:id/pose/:participantId",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const pose = await getParticipantPose(req.params.id, req.params.participantId);
        if (!pose) {
          return apiError(res, 404, "NOT_FOUND", "room or participant not found");
        }
        return res.json({ _version: 1, pose });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/vr-rooms/:id/objects
  apiRoute("post", "/vr-rooms/:id/objects", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.type || typeof body.type !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "type is required");
      }
      const object = await spawnObject(req.params.id, {
        type: body.type,
        position: body.position,
        rotation: body.rotation,
        owner: body.owner || req.userId || null,
        properties: body.properties,
      });
      return res.status(201).json({ _version: 1, object });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // PUT /api/v1/vr-rooms/:id/objects/:objId
  apiRoute("put", "/vr-rooms/:id/objects/:objId", log, auth, scope("write"), async (req, res) => {
    try {
      const object = await updateObject(req.params.id, req.params.objId, req.body || {});
      return res.json({ _version: 1, object });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/vr-rooms/:id/objects/:objId
  apiRoute(
    "delete",
    "/vr-rooms/:id/objects/:objId",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const ok = await removeObject(req.params.id, req.params.objId);
        if (!ok) {
          return apiError(res, 404, "NOT_FOUND", "object or room not found");
        }
        return res.json({ _version: 1, deleted: true });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // GET /api/v1/vr-rooms/:id/objects
  apiRoute("get", "/vr-rooms/:id/objects", log, auth, scope("read"), async (req, res) => {
    try {
      const room = await getRoom(req.params.id);
      if (!room) {
        return apiError(res, 404, "NOT_FOUND", `room ${req.params.id} not found`);
      }
      const objects = await getRoomObjects(req.params.id);
      return res.json({ _version: 1, objects, count: objects.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/vr-rooms/:id/voice
  apiRoute("post", "/vr-rooms/:id/voice", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.participantId) {
        return apiError(res, 400, "INVALID_INPUT", "participantId is required");
      }
      const voice = await setVoiceState(req.params.id, body.participantId, body.state || {});
      return res.json({ _version: 1, voice });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountVrRoomsRoutes;
