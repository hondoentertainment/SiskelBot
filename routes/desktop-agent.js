import {
  createDesktopSession,
  stopDesktopSession,
  getDesktopSession,
  listDesktopSessions,
  takeScreenshot,
  sendMouseClick,
  sendKeypress,
  sendType,
  openApplication,
} from "../lib/desktop-agent.js";

export function mountDesktopAgentRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute(
    "post",
    "/workspaces/:workspaceId/desktop-sessions",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      const { workspaceId } = req.params;
      try {
        const session = await createDesktopSession(workspaceId, req.body || {});
        res.status(201).json(session);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Create session failed");
      }
    },
  );

  apiRoute(
    "get",
    "/workspaces/:workspaceId/desktop-sessions",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      const { workspaceId } = req.params;
      try {
        const sessions = await listDesktopSessions(workspaceId);
        res.json({ sessions });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List sessions failed");
      }
    },
  );

  apiRoute(
    "get",
    "/workspaces/:workspaceId/desktop-sessions/:sessionId",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      const { workspaceId, sessionId } = req.params;
      try {
        const session = await getDesktopSession(workspaceId, sessionId);
        if (!session) {
          return apiError(res, 404, "NOT_FOUND", "Session not found");
        }
        res.json(session);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Get session failed");
      }
    },
  );

  apiRoute(
    "delete",
    "/workspaces/:workspaceId/desktop-sessions/:sessionId",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      const { workspaceId, sessionId } = req.params;
      try {
        const stopped = await stopDesktopSession(workspaceId, sessionId);
        if (!stopped) {
          return apiError(res, 404, "NOT_FOUND", "Session not found");
        }
        res.json(stopped);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Stop session failed");
      }
    },
  );

  apiRoute(
    "post",
    "/workspaces/:workspaceId/desktop-sessions/:sessionId/screenshot",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      const { workspaceId, sessionId } = req.params;
      try {
        const result = await takeScreenshot(workspaceId, sessionId);
        res.json(result);
      } catch (err) {
        const status = /not found/i.test(err?.message) ? 404 : 500;
        const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
        return apiError(res, status, code, err?.message || "Screenshot failed");
      }
    },
  );

  apiRoute(
    "post",
    "/workspaces/:workspaceId/desktop-sessions/:sessionId/click",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      const { workspaceId, sessionId } = req.params;
      const { x, y, button } = req.body || {};
      if (x == null || y == null) {
        return apiError(res, 400, "INVALID_INPUT", "x and y are required");
      }
      try {
        const result = await sendMouseClick(workspaceId, sessionId, Number(x), Number(y), button ?? 1);
        res.json(result);
      } catch (err) {
        const status = /not found/i.test(err?.message) ? 404 : 500;
        const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
        return apiError(res, status, code, err?.message || "Click failed");
      }
    },
  );

  apiRoute(
    "post",
    "/workspaces/:workspaceId/desktop-sessions/:sessionId/keypress",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      const { workspaceId, sessionId } = req.params;
      const { keys } = req.body || {};
      if (!keys) {
        return apiError(res, 400, "INVALID_INPUT", "keys is required");
      }
      try {
        const result = await sendKeypress(workspaceId, sessionId, keys);
        res.json(result);
      } catch (err) {
        const status = /not found/i.test(err?.message) ? 404 : 500;
        const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
        return apiError(res, status, code, err?.message || "Keypress failed");
      }
    },
  );

  apiRoute(
    "post",
    "/workspaces/:workspaceId/desktop-sessions/:sessionId/type",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      const { workspaceId, sessionId } = req.params;
      const { text } = req.body || {};
      if (text == null) {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      try {
        const result = await sendType(workspaceId, sessionId, text);
        res.json(result);
      } catch (err) {
        const status = /not found/i.test(err?.message) ? 404 : 500;
        const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
        return apiError(res, status, code, err?.message || "Type failed");
      }
    },
  );

  apiRoute(
    "post",
    "/workspaces/:workspaceId/desktop-sessions/:sessionId/open",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      const { workspaceId, sessionId } = req.params;
      const { app } = req.body || {};
      if (!app) {
        return apiError(res, 400, "INVALID_INPUT", "app is required");
      }
      try {
        const result = await openApplication(workspaceId, sessionId, app);
        res.json(result);
      } catch (err) {
        const status = /not found/i.test(err?.message) ? 404 : 500;
        const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
        return apiError(res, status, code, err?.message || "Open application failed");
      }
    },
  );
}
