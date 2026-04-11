/**
 * Phase 55.5: Mobile automation bridges routes.
 *
 * POST   /api/v1/mobile-automation/sessions/adb   -- body { deviceId }
 * POST   /api/v1/mobile-automation/sessions/xcui  -- body { udid, bundleId? }
 * GET    /api/v1/mobile-automation/sessions
 * DELETE /api/v1/mobile-automation/sessions/:id
 * POST   /api/v1/mobile-automation/execute        -- body { sessionId, action, ... }
 * GET    /api/v1/mobile-automation/commands
 * POST   /api/v1/mobile-automation/parse          -- body { dump }
 *
 * The production endpoints rely on real `adb` / `xcrun` binaries being
 * available on the server; in tests we inject a mock `exec`. The route
 * handler loads the real exec from node:child_process at session creation
 * time.
 */
import {
  createAdbSession,
  createXcuiSession,
  executeMobileCommand,
  listSupportedCommands,
  parseHierarchy,
  listMobileSessions,
  deleteMobileSession,
} from "../lib/mobile-automation.js";
import { exec as childExec } from "child_process";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "mobile-automation error");
}

// Sessions are kept in an in-memory map so execute calls can reuse the exec
// binding that was registered when the session was created. Persistence is
// managed inside lib/mobile-automation.js for history only.
const LIVE_SESSIONS = new Map();

export function mountMobileAutomationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/mobile-automation/sessions/adb", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.deviceId || typeof body.deviceId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "deviceId is required");
      }
      const session = await createAdbSession({ deviceId: body.deviceId, exec: childExec });
      LIVE_SESSIONS.set(session.id, session);
      return res.status(201).json({
        _version: 1,
        session: {
          id: session.id,
          platform: session.platform,
          deviceId: session.deviceId,
          createdAt: session.createdAt,
        },
      });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/mobile-automation/sessions/xcui", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.udid || typeof body.udid !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "udid is required");
      }
      const session = await createXcuiSession({
        udid: body.udid,
        bundleId: body.bundleId,
        exec: childExec,
      });
      LIVE_SESSIONS.set(session.id, session);
      return res.status(201).json({
        _version: 1,
        session: {
          id: session.id,
          platform: session.platform,
          deviceId: session.deviceId,
          bundleId: session.bundleId,
          createdAt: session.createdAt,
        },
      });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/mobile-automation/sessions", log, admin, async (_req, res) => {
    try {
      const list = await listMobileSessions();
      return res.json({ _version: 1, sessions: list });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/mobile-automation/sessions/:id", log, admin, async (req, res) => {
    try {
      LIVE_SESSIONS.delete(req.params.id);
      const ok = await deleteMobileSession(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", "session not found");
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/mobile-automation/execute", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.sessionId || typeof body.sessionId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      }
      const session = LIVE_SESSIONS.get(body.sessionId);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", "session not found (recreate after restart)");
      }
      const result = await executeMobileCommand(session, body);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/mobile-automation/commands", log, admin, async (_req, res) => {
    try {
      return res.json({ _version: 1, commands: listSupportedCommands() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/mobile-automation/parse", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.dump !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "dump is required");
      }
      const parsed = parseHierarchy(body.dump);
      return res.json({ _version: 1, parsed });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountMobileAutomationRoutes;
