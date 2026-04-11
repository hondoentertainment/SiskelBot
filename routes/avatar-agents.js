/**
 * Phase 49.3: Avatar agents REST API.
 *
 * Routes:
 *   POST   /api/v1/avatars                 create an avatar config
 *   GET    /api/v1/avatars                 list avatar configs (filter by agentId/workspaceId/userId)
 *   GET    /api/v1/avatars/presets         list default primitive presets
 *   GET    /api/v1/avatars/:id             fetch a single avatar
 *   PUT    /api/v1/avatars/:id             merge updates into an avatar
 *   DELETE /api/v1/avatars/:id             delete avatar + cascade state and session tracking
 *   POST   /api/v1/avatars/:id/state       set animation state
 *   GET    /api/v1/avatars/:id/state       read animation state
 *   POST   /api/v1/avatars/:id/lipsync     compute visemes from audio metadata
 *   POST   /api/v1/avatars/emotion         classify emotion from text
 */
import {
  DEFAULT_AVATAR_MODELS,
  createAvatarConfig,
  getAvatarConfig,
  listAvatars,
  updateAvatarConfig,
  deleteAvatarConfig,
  setAvatarState,
  getAvatarState,
  computeLipSync,
  computeEmotionFromText,
} from "../lib/avatar-agents.js";

export function mountAvatarAgentsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/avatars
  apiRoute("post", "/avatars", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const cfg = await createAvatarConfig({
        agentId: body.agentId,
        workspaceId: body.workspaceId,
        userId: body.userId,
        modelRef: body.modelRef,
        voice: body.voice,
        position: body.position,
        rotation: body.rotation,
        scale: body.scale,
        metadata: body.metadata,
      });
      return res.status(201).json({ _version: 1, avatar: cfg });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to create avatar");
    }
  });

  // GET /api/v1/avatars/presets
  // Register before /:id so Express does not try to match "presets" as an id
  // parameter and skip this handler.
  apiRoute("get", "/avatars/presets", log, auth, scope("read"), async (_req, res) => {
    try {
      return res.json({ _version: 1, presets: DEFAULT_AVATAR_MODELS });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to list presets");
    }
  });

  // POST /api/v1/avatars/emotion
  apiRoute("post", "/avatars/emotion", log, auth, scope("read"), async (req, res) => {
    try {
      const text = req.body?.text;
      if (typeof text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const emotion = computeEmotionFromText(text);
      return res.json({ _version: 1, emotion });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to classify emotion");
    }
  });

  // GET /api/v1/avatars
  apiRoute("get", "/avatars", log, auth, scope("read"), async (req, res) => {
    try {
      const filter = {
        agentId: req.query?.agentId ? String(req.query.agentId) : undefined,
        workspaceId: req.query?.workspaceId ? String(req.query.workspaceId) : undefined,
        userId: req.query?.userId ? String(req.query.userId) : undefined,
      };
      const avatars = await listAvatars(filter);
      return res.json({ _version: 1, avatars, count: avatars.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to list avatars");
    }
  });

  // GET /api/v1/avatars/:id
  apiRoute("get", "/avatars/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const cfg = await getAvatarConfig(req.params.id);
      if (!cfg) {
        return apiError(res, 404, "NOT_FOUND", `avatar ${req.params.id} not found`);
      }
      return res.json({ _version: 1, avatar: cfg });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to fetch avatar");
    }
  });

  // PUT /api/v1/avatars/:id
  apiRoute("put", "/avatars/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const updated = await updateAvatarConfig(req.params.id, req.body || {});
      if (!updated) {
        return apiError(res, 404, "NOT_FOUND", `avatar ${req.params.id} not found`);
      }
      return res.json({ _version: 1, avatar: updated });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to update avatar");
    }
  });

  // DELETE /api/v1/avatars/:id
  apiRoute("delete", "/avatars/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const result = await deleteAvatarConfig(req.params.id);
      if (!result.ok) {
        return apiError(res, 404, "NOT_FOUND", `avatar ${req.params.id} not found`);
      }
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to delete avatar");
    }
  });

  // POST /api/v1/avatars/:id/state
  apiRoute("post", "/avatars/:id/state", log, auth, scope("write"), async (req, res) => {
    try {
      const existing = await getAvatarConfig(req.params.id);
      if (!existing) {
        return apiError(res, 404, "NOT_FOUND", `avatar ${req.params.id} not found`);
      }
      const state = await setAvatarState(req.params.id, req.body || {});
      return res.json({ _version: 1, state });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to set state");
    }
  });

  // GET /api/v1/avatars/:id/state
  apiRoute("get", "/avatars/:id/state", log, auth, scope("read"), async (req, res) => {
    try {
      const state = await getAvatarState(req.params.id);
      if (!state) {
        return apiError(res, 404, "NOT_FOUND", `no state for avatar ${req.params.id}`);
      }
      return res.json({ _version: 1, state });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to fetch state");
    }
  });

  // POST /api/v1/avatars/:id/lipsync
  apiRoute("post", "/avatars/:id/lipsync", log, auth, scope("read"), async (req, res) => {
    try {
      const existing = await getAvatarConfig(req.params.id);
      if (!existing) {
        return apiError(res, 404, "NOT_FOUND", `avatar ${req.params.id} not found`);
      }
      const body = req.body || {};
      const frames = computeLipSync(
        {
          durationMs: body.durationMs,
          envelope: body.envelope,
          text: body.text,
        },
        body.visemeSet || "default",
      );
      return res.json({ _version: 1, frames, count: frames.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "failed to compute lipsync");
    }
  });
}

export default mountAvatarAgentsRoutes;
