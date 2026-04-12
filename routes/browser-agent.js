/**
 * Phase 55.2: Browser agent routes.
 *
 * Wires the pluggable browser agent to HTTP endpoints under /api/v1/browser/*
 * All endpoints enforce the URL allowlist/blocklist defined in lib/browser-agent.js
 * and validate input before touching any driver. Page handles are held in
 * process by the lib layer and keyed by sessionId.
 *
 *   POST   /api/v1/browser/open               — open a page (creates a session)
 *   POST   /api/v1/browser/click              — click a selector
 *   POST   /api/v1/browser/type               — type text into a selector
 *   POST   /api/v1/browser/extract            — extract text from a selector
 *   POST   /api/v1/browser/screenshot         — take a screenshot (base64)
 *   POST   /api/v1/browser/navigate           — navigate to a new URL
 *   POST   /api/v1/browser/form               — fill a form from key/value map
 *   POST   /api/v1/browser/script             — run a sandboxed script
 *   POST   /api/v1/browser/session            — create an empty session
 *   DELETE /api/v1/browser/session/:id        — close a session
 *   GET    /api/v1/browser/sessions           — list all sessions
 */
import {
  openPage,
  clickElement,
  typeInField,
  extractText,
  screenshot,
  navigate,
  fillForm,
  runScript,
  createBrowserSession,
  getBrowserSession,
  closeBrowserSession,
  listBrowserSessions,
  _getPageHandle,
  _setPageHandle,
} from "../lib/browser-agent.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/not allowed|script blocked|is required|must be|invalid/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code =
    status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "BROWSER_AGENT_ERROR";
  return apiError(res, status, code, err?.message || "browser-agent error");
}

async function ensureSessionPage(sessionId) {
  const session = await getBrowserSession(sessionId);
  if (!session) {
    const err = new Error(`session ${sessionId} not found`);
    throw err;
  }
  const page = _getPageHandle(sessionId);
  if (!page) {
    const err = new Error(`session ${sessionId} has no active page`);
    throw err;
  }
  return { session, page };
}

export function mountBrowserAgentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, chatAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function"
    ? userAuth
    : typeof chatAuth === "function"
      ? chatAuth
      : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/browser/open — body: { url, options }
  apiRoute("post", "/browser/open", log, auth, scope("write"), async (req, res) => {
    try {
      const { url, options } = req.body || {};
      if (!url || typeof url !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "url is required");
      }
      const opts = options && typeof options === "object" ? options : {};
      const name = opts.name || `open-${Date.now()}`;
      // Create a session without the URL so we can handle errors separately.
      const session = await createBrowserSession(name, { driver: opts.driver || "mock" });
      try {
        const { page } = await openPage(url, opts);
        _setPageHandle(session.id, page);
        return res.status(201).json({
          _version: 1,
          sessionId: session.id,
          session: { ...session, status: "open", url },
        });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/click — body: { sessionId, selector }
  apiRoute("post", "/browser/click", log, auth, scope("write"), async (req, res) => {
    try {
      const { sessionId, selector } = req.body || {};
      if (!sessionId) return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      if (!selector) return apiError(res, 400, "INVALID_INPUT", "selector is required");
      const { page } = await ensureSessionPage(sessionId);
      const result = await clickElement(page, selector);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/type — body: { sessionId, selector, text }
  apiRoute("post", "/browser/type", log, auth, scope("write"), async (req, res) => {
    try {
      const { sessionId, selector, text } = req.body || {};
      if (!sessionId) return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      if (!selector) return apiError(res, 400, "INVALID_INPUT", "selector is required");
      if (typeof text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text must be a string");
      }
      const { page } = await ensureSessionPage(sessionId);
      const result = await typeInField(page, selector, text);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/extract — body: { sessionId, selector }
  apiRoute("post", "/browser/extract", log, auth, scope("read"), async (req, res) => {
    try {
      const { sessionId, selector } = req.body || {};
      if (!sessionId) return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      if (!selector) return apiError(res, 400, "INVALID_INPUT", "selector is required");
      const { page } = await ensureSessionPage(sessionId);
      const text = await extractText(page, selector);
      return res.json({ _version: 1, text });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/screenshot — body: { sessionId }
  apiRoute("post", "/browser/screenshot", log, auth, scope("read"), async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      const { page } = await ensureSessionPage(sessionId);
      const buf = await screenshot(page);
      return res.json({
        _version: 1,
        contentType: "image/png",
        bytes: buf.length,
        data: buf.toString("base64"),
      });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/navigate — body: { sessionId, url }
  apiRoute("post", "/browser/navigate", log, auth, scope("write"), async (req, res) => {
    try {
      const { sessionId, url } = req.body || {};
      if (!sessionId) return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      if (!url || typeof url !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "url is required");
      }
      const { page } = await ensureSessionPage(sessionId);
      const result = await navigate(page, url);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/form — body: { sessionId, formData }
  apiRoute("post", "/browser/form", log, auth, scope("write"), async (req, res) => {
    try {
      const { sessionId, formData } = req.body || {};
      if (!sessionId) return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      if (!formData || typeof formData !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "formData must be an object");
      }
      const { page } = await ensureSessionPage(sessionId);
      const result = await fillForm(page, formData);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/script — body: { sessionId, code }
  apiRoute("post", "/browser/script", log, auth, scope("write"), async (req, res) => {
    try {
      const { sessionId, code } = req.body || {};
      if (!sessionId) return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      if (!code || typeof code !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "code is required");
      }
      const { page } = await ensureSessionPage(sessionId);
      const result = await runScript(page, code);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/browser/session — create an empty session
  apiRoute("post", "/browser/session", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const name = body.name || `session-${Date.now()}`;
      const session = await createBrowserSession(name, body.options || {});
      return res.status(201).json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/browser/session/:id — close a session
  apiRoute("delete", "/browser/session/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const { id } = req.params;
      const closed = await closeBrowserSession(id);
      if (!closed) {
        return apiError(res, 404, "NOT_FOUND", `session ${id} not found`);
      }
      return res.json({ _version: 1, session: closed });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/browser/sessions — list all sessions
  apiRoute("get", "/browser/sessions", log, auth, scope("read"), async (_req, res) => {
    try {
      const sessions = await listBrowserSessions();
      return res.json({ _version: 1, sessions, count: sessions.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountBrowserAgentRoutes;
