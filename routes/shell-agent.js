/**
 * Phase 55.3: Shell agent routes.
 *
 * POST   /api/v1/shell/execute                          — run a validated command
 * POST   /api/v1/shell/dry-run                          — describe what would run
 * POST   /api/v1/shell/validate                         — check command against policy
 * POST   /api/v1/shell/session                          — create a shell session
 * GET    /api/v1/shell/session/:id                      — fetch session metadata
 * GET    /api/v1/shell/sessions                         — list sessions
 * DELETE /api/v1/shell/session/:id                      — close a session
 * POST   /api/v1/shell/session/:id/checkpoint           — create a checkpoint
 * GET    /api/v1/shell/session/:id/checkpoints          — list checkpoints
 * POST   /api/v1/shell/session/:id/rollback/:name       — rollback to checkpoint
 * GET    /api/v1/shell/session/:id/history              — command history
 *
 * These endpoints are restricted to authenticated callers and require the
 * `write` scope for any state-modifying operation.
 */
import {
  validateCommand,
  dryRun,
  executeCommand,
  createShellSession,
  getShellSession,
  listShellSessions,
  closeShellSession,
  createCheckpoint,
  listCheckpoints,
  rollbackToCheckpoint,
  getCommandHistory,
  recordCommand,
  enforceLimits,
} from "../lib/shell-agent.js";

function mapErrorStatus(err) {
  const code = err?.code;
  if (code === "COMMAND_BLOCKED") return 403;
  if (code === "COMMAND_INVALID") return 400;
  if (code === "RATE_LIMIT_EXCEEDED") return 429;
  const msg = String(err?.message || "");
  if (/not found/i.test(msg)) return 404;
  if (/required|invalid|must be/i.test(msg)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err);
  const code =
    status === 404
      ? "NOT_FOUND"
      : status === 403
        ? "FORBIDDEN"
        : status === 429
          ? "RATE_LIMITED"
          : status === 400
            ? "INVALID_INPUT"
            : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "shell-agent error");
}

export function mountShellAgentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/shell/execute
  apiRoute("post", "/shell/execute", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.command || typeof body.command !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "command is required");
      }
      const options = body.options && typeof body.options === "object" ? body.options : {};
      let session = null;
      if (body.sessionId) {
        session = await getShellSession(body.sessionId);
        if (!session) {
          return apiError(res, 404, "NOT_FOUND", `session ${body.sessionId} not found`);
        }
        if (session.status !== "active") {
          return apiError(res, 400, "INVALID_INPUT", `session ${body.sessionId} is closed`);
        }
        await enforceLimits(body.command, session);
      }
      const result = await executeCommand(body.command, {
        ...options,
        cwd: options.cwd || session?.cwd,
        env: { ...(session?.env || {}), ...(options.env || {}) },
        policy: options.policy || session?.policy,
      });
      if (session) {
        await recordCommand(session.id, body.command, result);
      }
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/shell/dry-run
  apiRoute("post", "/shell/dry-run", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.command || typeof body.command !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "command is required");
      }
      const result = dryRun(body.command, body.policy || {});
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/shell/validate
  apiRoute("post", "/shell/validate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.command || typeof body.command !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "command is required");
      }
      const validation = validateCommand(body.command, body.policy || {});
      return res.json({ _version: 1, validation });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/shell/session
  apiRoute("post", "/shell/session", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const session = await createShellSession(body.name, {
        cwd: body.cwd,
        env: body.env,
        policy: body.policy,
      });
      return res.status(201).json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/shell/sessions
  apiRoute("get", "/shell/sessions", log, auth, scope("read"), async (_req, res) => {
    try {
      const sessions = await listShellSessions();
      return res.json({ _version: 1, sessions, count: sessions.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/shell/session/:id
  apiRoute("get", "/shell/session/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const session = await getShellSession(req.params.id);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", `session ${req.params.id} not found`);
      }
      return res.json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/shell/session/:id
  apiRoute("delete", "/shell/session/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const session = await closeShellSession(req.params.id);
      if (!session) {
        return apiError(res, 404, "NOT_FOUND", `session ${req.params.id} not found`);
      }
      return res.json({ _version: 1, session });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/shell/session/:id/checkpoint
  apiRoute(
    "post",
    "/shell/session/:id/checkpoint",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        if (!body.name || typeof body.name !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "checkpoint name is required");
        }
        const session = await getShellSession(req.params.id);
        if (!session) {
          return apiError(res, 404, "NOT_FOUND", `session ${req.params.id} not found`);
        }
        const checkpoint = await createCheckpoint(req.params.id, body.name, {
          dir: body.dir || session.cwd,
          captureContent: body.captureContent === true,
          maxFiles: body.maxFiles,
          maxDepth: body.maxDepth,
        });
        return res.status(201).json({
          _version: 1,
          checkpoint: {
            id: checkpoint.id,
            name: checkpoint.name,
            sessionId: checkpoint.sessionId,
            dir: checkpoint.dir,
            createdAt: checkpoint.createdAt,
            fileCount: checkpoint.fileCount,
            capturedContent: checkpoint.capturedContent,
          },
        });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // GET /api/v1/shell/session/:id/checkpoints
  apiRoute(
    "get",
    "/shell/session/:id/checkpoints",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const checkpoints = await listCheckpoints(req.params.id);
        return res.json({ _version: 1, checkpoints, count: checkpoints.length });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // POST /api/v1/shell/session/:id/rollback/:name
  apiRoute(
    "post",
    "/shell/session/:id/rollback/:name",
    log,
    auth,
    scope("write"),
    async (req, res) => {
      try {
        const body = req.body || {};
        const result = await rollbackToCheckpoint(req.params.id, req.params.name, {
          simulate: body.simulate === true,
        });
        return res.json({ _version: 1, result });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );

  // GET /api/v1/shell/session/:id/history
  apiRoute("get", "/shell/session/:id/history", log, auth, scope("read"), async (req, res) => {
    try {
      const limit = Number.parseInt(req.query?.limit, 10);
      const history = await getCommandHistory(
        req.params.id,
        Number.isFinite(limit) && limit > 0 ? limit : 100,
      );
      return res.json({ _version: 1, history, count: history.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountShellAgentRoutes;
