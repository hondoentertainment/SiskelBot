/**
 * Phase 44.1: Real-time voice conversation routes.
 *
 * REST surface for managing voice sessions; the actual streaming audio
 * is exchanged over the WebSocket channel at /ws/voice (handled in
 * lib/realtime.js).
 *
 * POST   /api/v1/voice/sessions              — create a session
 * DELETE /api/v1/voice/sessions/:id          — end a session
 * GET    /api/v1/voice/sessions/:id/stats    — session statistics
 * GET    /api/v1/voice/sessions              — list active sessions
 */

import {
  createVoiceSession,
  getVoiceSession,
  listActiveSessions,
} from "../lib/voice-realtime.js";

export function mountVoiceRealtimeRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  // POST /api/v1/voice/sessions
  apiRoute("post", "/voice/sessions", logRequest, async (req, res) => {
    try {
      const { sttProvider, ttsProvider, model, voice } = req.body || {};
      const userId = req.userId || "anonymous";
      const workspaceId = req.body?.workspace || req.query?.workspace || "default";

      const session = createVoiceSession({
        sttProvider,
        ttsProvider,
        model,
        voice,
        userId,
        workspaceId,
      });

      // Mark active so HTTP-only callers (no WS yet) can later attach.
      await session.startSession(null, null, null);

      res.status(201).json({
        sessionId: session.id,
        wsPath: "/ws/voice",
        startedAt: session.getStats().startedAt,
      });
    } catch (err) {
      return apiError(res, 500, "VOICE_SESSION_FAILED", err.message);
    }
  });

  // DELETE /api/v1/voice/sessions/:id
  apiRoute("delete", "/voice/sessions/:id", logRequest, async (req, res) => {
    try {
      const session = getVoiceSession(req.params.id);
      if (!session) {
        return apiError(res, 404, "SESSION_NOT_FOUND", `Voice session ${req.params.id} not found`);
      }
      const stats = await session.endSession();
      res.json({ ok: true, stats });
    } catch (err) {
      return apiError(res, 500, "VOICE_SESSION_END_FAILED", err.message);
    }
  });

  // GET /api/v1/voice/sessions/:id/stats
  apiRoute("get", "/voice/sessions/:id/stats", logRequest, async (req, res) => {
    try {
      const session = getVoiceSession(req.params.id);
      if (!session) {
        return apiError(res, 404, "SESSION_NOT_FOUND", `Voice session ${req.params.id} not found`);
      }
      res.json(session.getStats());
    } catch (err) {
      return apiError(res, 500, "VOICE_STATS_FAILED", err.message);
    }
  });

  // GET /api/v1/voice/sessions
  apiRoute("get", "/voice/sessions", logRequest, async (_req, res) => {
    try {
      const ids = listActiveSessions();
      res.json({ sessions: ids });
    } catch (err) {
      return apiError(res, 500, "VOICE_LIST_FAILED", err.message);
    }
  });
}

export default mountVoiceRealtimeRoutes;
