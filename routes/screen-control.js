/**
 * Phase 55.1: Screen-control agent routes.
 *
 * POST   /api/v1/screen/action            — execute one action (dryRun by default unless explicit executor)
 * POST   /api/v1/screen/sequence          — execute a sequence of actions
 * POST   /api/v1/screen/validate          — validate an action against safety rails + policy
 * POST   /api/v1/screen/session           — create a recording session
 * GET    /api/v1/screen/session/:id       — fetch a session
 * GET    /api/v1/screen/sessions          — list sessions (optional ?workspaceId=)
 * POST   /api/v1/screen/session/:id/action — append a recorded action to a session
 * POST   /api/v1/screen/session/:id/undo  — remove the last recorded action
 * POST   /api/v1/screen/click             — convenience click
 * POST   /api/v1/screen/type              — convenience type
 * POST   /api/v1/screen/screenshot        — convenience screenshot
 */
import {
  Action,
  ActionSequence,
  executeAction,
  executeSequence,
  validateAction,
  createSession,
  getSession,
  listSessions,
  recordSessionAction,
  undoLastAction,
  clickAt,
  typeText,
  takeScreenshot,
} from "../lib/screen-control.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must|invalid|unknown|denied|forbidden|exceeds|bounds/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "screen-control error");
}

function parseAction(body) {
  if (!body || typeof body !== "object") {
    throw new Error("request body is required");
  }
  const raw = body.action || body;
  if (!raw || typeof raw !== "object") {
    throw new Error("action object is required");
  }
  if (!raw.type) {
    throw new Error("action.type is required");
  }
  return Action.fromJSON(raw);
}

export function mountScreenControlRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/screen/action
  apiRoute("post", "/screen/action", log, auth, scope("write"), async (req, res) => {
    try {
      const action = parseAction(req.body);
      const options = {
        executor: req.body?.executor, // default mock if omitted
        policy: req.body?.policy,
        dryRun: req.body?.dryRun === true,
      };
      const result = await executeAction(action, options);
      const status = result.success ? 200 : 400;
      return res.status(status).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/sequence
  apiRoute("post", "/screen/sequence", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const rawSeq = body.sequence || body;
      if (!rawSeq || (!Array.isArray(rawSeq) && !Array.isArray(rawSeq.actions))) {
        return apiError(res, 400, "INVALID_INPUT", "sequence.actions array is required");
      }
      const seq = Array.isArray(rawSeq)
        ? new ActionSequence(rawSeq.map((a) => Action.fromJSON(a)))
        : ActionSequence.fromJSON(rawSeq);
      const options = {
        executor: body.executor,
        policy: body.policy,
        dryRun: body.dryRun === true,
        continueOnFailure: body.continueOnFailure === true,
      };
      const result = await executeSequence(seq, options);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/validate
  apiRoute("post", "/screen/validate", log, auth, scope("read"), async (req, res) => {
    try {
      const action = parseAction(req.body);
      const result = validateAction(action, req.body?.policy || {});
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/session
  apiRoute("post", "/screen/session", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      const metadata = body.metadata && typeof body.metadata === "object" ? body.metadata : {};
      if (body.workspaceId && !metadata.workspaceId) metadata.workspaceId = body.workspaceId;
      const session = await createSession(body.name, metadata);
      return res.status(201).json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/screen/session/:id
  apiRoute("get", "/screen/session/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const session = await getSession(req.params.id);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", `session ${req.params.id} not found`);
      }
      return res.json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/screen/sessions
  apiRoute("get", "/screen/sessions", log, auth, scope("read"), async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId ? String(req.query.workspaceId) : undefined;
      const sessions = await listSessions(workspaceId);
      return res.json({ _version: 1, sessions, count: sessions.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/session/:id/action
  apiRoute("post", "/screen/session/:id/action", log, auth, scope("write"), async (req, res) => {
    try {
      const action = parseAction(req.body);
      const recorded = await recordSessionAction(req.params.id, action);
      return res.status(201).json({ _version: 1, action: recorded });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/session/:id/undo
  apiRoute("post", "/screen/session/:id/undo", log, auth, scope("write"), async (req, res) => {
    try {
      const result = await undoLastAction(req.params.id);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/click — convenience
  apiRoute("post", "/screen/click", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
        return apiError(res, 400, "INVALID_INPUT", "x and y are required numbers");
      }
      const result = await clickAt(body.x, body.y, {
        executor: body.executor,
        policy: body.policy,
        dryRun: body.dryRun === true,
      });
      return res.status(result.success ? 200 : 400).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/type — convenience
  apiRoute("post", "/screen/type", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const result = await typeText(body.text, {
        executor: body.executor,
        policy: body.policy,
        dryRun: body.dryRun === true,
      });
      return res.status(result.success ? 200 : 400).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/screen/screenshot — convenience
  apiRoute("post", "/screen/screenshot", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await takeScreenshot({
        executor: body.executor,
        policy: body.policy,
        dryRun: body.dryRun === true,
      });
      return res.status(result.success ? 200 : 400).json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountScreenControlRoutes;
