/**
 * Phase 44.5: Meeting bot REST API.
 *
 * Routes:
 *   POST   /api/v1/meetings/join                   join a meeting as a bot
 *   POST   /api/v1/meetings/:id/leave              leave a meeting
 *   GET    /api/v1/meetings                        list meetings in workspace
 *   GET    /api/v1/meetings/:id                    get meeting metadata
 *   GET    /api/v1/meetings/:id/transcript         get transcript segments
 *   GET    /api/v1/meetings/:id/summary            get summary fields
 *   GET    /api/v1/meetings/:id/action-items       get action items
 *   POST   /api/v1/meetings/:id/summarize          (re)generate summary
 *   POST   /api/v1/meetings/:id/extract-actions    (re)extract action items
 *   DELETE /api/v1/meetings/:id                    soft-delete a meeting
 */
import {
  joinMeeting,
  leaveMeeting,
  listMeetings,
  getMeeting,
  deleteMeeting,
  summarizeMeeting,
  extractActionItemsForMeeting,
} from "../lib/meeting-bot.js";

export function mountMeetingBotRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    sanitizeWorkspace,
    storageRateLimiter,
    userAuth,
    requireScope,
    logRequest,
  } = deps;

  const limiter = storageRateLimiter || ((_req, _res, next) => next());
  const auth = userAuth || ((_req, _res, next) => next());
  const scopeRead = (requireScope && requireScope("read")) || ((_req, _res, next) => next());
  const scopeWrite = (requireScope && requireScope("write")) || ((_req, _res, next) => next());
  const log = logRequest || ((_req, _res, next) => next());
  const sanitizeWs = sanitizeWorkspace || ((v) => (typeof v === "string" && v.trim()) ? v.trim() : "default");

  function readWorkspace(req) {
    return sanitizeWs(
      req.body?.workspace || req.body?.workspaceId || req.query?.workspace || req.query?.workspaceId || req.workspace || "default"
    );
  }

  // POST /api/v1/meetings/join
  apiRoute("post", "/meetings/join", limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.platform) {
        return apiError(res, 400, "INVALID_INPUT", "platform is required");
      }
      if (!body.meetingUrl) {
        return apiError(res, 400, "INVALID_INPUT", "meetingUrl is required");
      }
      const workspaceId = readWorkspace(req);
      const result = await joinMeeting({
        platform: body.platform,
        meetingUrl: body.meetingUrl,
        displayName: body.displayName,
        botToken: body.botToken,
        meetingId: body.meetingId,
        passcode: body.passcode,
        workspaceId,
      });
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/required|platform must be|adapter|unknown platform/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/meetings/:id/leave
  apiRoute("post", "/meetings/:id/leave", limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const sessionId = String(req.body?.sessionId || req.params.id || "").trim();
      if (!sessionId) {
        return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      }
      const result = await leaveMeeting(sessionId);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/required/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/meetings
  apiRoute("get", "/meetings", limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      const limit = Number(req.query?.limit) || 50;
      const offset = Number(req.query?.offset) || 0;
      const status = typeof req.query?.status === "string" ? req.query.status : undefined;
      const platform = typeof req.query?.platform === "string" ? req.query.platform : undefined;
      const items = await listMeetings(workspaceId, { limit, offset, status, platform });
      res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/meetings/:id
  apiRoute("get", "/meetings/:id", limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      const meeting = await getMeeting(req.params.id, workspaceId);
      if (!meeting) {
        return apiError(res, 404, "NOT_FOUND", "meeting not found");
      }
      res.json({ _version: 1, meeting });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/meetings/:id/transcript
  apiRoute("get", "/meetings/:id/transcript", limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      const meeting = await getMeeting(req.params.id, workspaceId);
      if (!meeting) {
        return apiError(res, 404, "NOT_FOUND", "meeting not found");
      }
      res.json({
        _version: 1,
        meetingId: meeting.id,
        transcript: meeting.transcript,
        count: meeting.transcript.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/meetings/:id/summary
  apiRoute("get", "/meetings/:id/summary", limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      const meeting = await getMeeting(req.params.id, workspaceId);
      if (!meeting) {
        return apiError(res, 404, "NOT_FOUND", "meeting not found");
      }
      res.json({
        _version: 1,
        meetingId: meeting.id,
        summary: meeting.summary,
        topics: meeting.topics,
        decisions: meeting.decisions,
        attendees: meeting.attendees,
        duration: meeting.duration,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/meetings/:id/action-items
  apiRoute("get", "/meetings/:id/action-items", limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      const meeting = await getMeeting(req.params.id, workspaceId);
      if (!meeting) {
        return apiError(res, 404, "NOT_FOUND", "meeting not found");
      }
      res.json({
        _version: 1,
        meetingId: meeting.id,
        actionItems: meeting.actionItems,
        count: meeting.actionItems.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/meetings/:id/summarize
  apiRoute("post", "/meetings/:id/summarize", limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      const result = await summarizeMeeting(req.params.id, workspaceId);
      res.json({ _version: 1, meetingId: req.params.id, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/meetings/:id/extract-actions
  apiRoute("post", "/meetings/:id/extract-actions", limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      const items = await extractActionItemsForMeeting(req.params.id, workspaceId);
      res.json({ _version: 1, meetingId: req.params.id, actionItems: items, count: items.length });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/meetings/:id
  apiRoute("delete", "/meetings/:id", limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const workspaceId = readWorkspace(req);
      await deleteMeeting(req.params.id, workspaceId);
      res.status(204).send();
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountMeetingBotRoutes;
