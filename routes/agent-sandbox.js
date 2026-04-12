/**
 * Phase 56.1: Docker agent sandbox routes.
 *
 * POST   /api/v1/sandbox/create              — create and start a sandbox
 * POST   /api/v1/sandbox/:id/exec            — run a command inside the sandbox
 * POST   /api/v1/sandbox/:id/stop            — stop a running sandbox
 * DELETE /api/v1/sandbox/:id                 — remove a sandbox (stops if running)
 * GET    /api/v1/sandbox/:id                 — fetch sandbox metadata
 * GET    /api/v1/sandbox/:id/logs            — fetch runtime logs
 * GET    /api/v1/sandboxes                   — list sandboxes (filterable)
 * GET    /api/v1/sandbox/images              — list available images
 */
import {
  SANDBOX_IMAGES,
  createSandbox,
  execInSandbox,
  stopSandbox,
  removeSandbox,
  getSandbox,
  listSandboxes,
  getSandboxLogs,
} from "../lib/agent-sandbox.js";

function mapErrorStatus(err) {
  const code = err?.code;
  if (code === "NOT_FOUND") return 404;
  if (code === "NOT_RUNNING") return 409;
  const msg = String(err?.message || "");
  if (/not found/i.test(msg)) return 404;
  if (/not running/i.test(msg)) return 409;
  if (/required|invalid|must be/i.test(msg)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err);
  const code =
    status === 404
      ? "NOT_FOUND"
      : status === 409
        ? "CONFLICT"
        : status === 400
          ? "INVALID_INPUT"
          : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "agent-sandbox error");
}

export function mountAgentSandboxRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/sandbox/images  -- keep before /:id routes to avoid shadowing
  apiRoute("get", "/sandbox/images", log, auth, scope("read"), async (_req, res) => {
    try {
      const images = Object.entries(SANDBOX_IMAGES).map(([key, info]) => ({
        key,
        base: info.base,
        tools: [...info.tools],
      }));
      return res.json({ _version: 1, images, count: images.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/sandbox/create
  apiRoute("post", "/sandbox/create", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.image || typeof body.image !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "image is required");
      }
      const options = body.options && typeof body.options === "object" ? body.options : {};
      const sandbox = await createSandbox(body.image, options);
      return res.status(201).json({ _version: 1, sandbox });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/sandbox/:id/exec
  apiRoute("post", "/sandbox/:id/exec", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.command || typeof body.command !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "command is required");
      }
      const options = body.options && typeof body.options === "object" ? body.options : {};
      const result = await execInSandbox(req.params.id, body.command, options);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/sandbox/:id/stop
  apiRoute("post", "/sandbox/:id/stop", log, auth, scope("write"), async (req, res) => {
    try {
      const sandbox = await stopSandbox(req.params.id);
      return res.json({ _version: 1, sandbox });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/sandbox/:id
  apiRoute("delete", "/sandbox/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const result = await removeSandbox(req.params.id);
      if (!result.removed) {
        return apiError(res, 404, "NOT_FOUND", `sandbox ${req.params.id} not found`);
      }
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/sandbox/:id/logs
  apiRoute("get", "/sandbox/:id/logs", log, auth, scope("read"), async (req, res) => {
    try {
      const tail = req.query?.tail ? Number(req.query.tail) : undefined;
      const logs = await getSandboxLogs(req.params.id, tail ? { tail } : {});
      return res.json({ _version: 1, logs, count: logs.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/sandbox/:id
  apiRoute("get", "/sandbox/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const sandbox = await getSandbox(req.params.id);
      if (!sandbox) {
        return apiError(res, 404, "NOT_FOUND", `sandbox ${req.params.id} not found`);
      }
      return res.json({ _version: 1, sandbox });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/sandboxes
  apiRoute("get", "/sandboxes", log, auth, scope("read"), async (req, res) => {
    try {
      const filter = {};
      if (req.query?.state) filter.state = String(req.query.state);
      if (req.query?.imageKey) filter.imageKey = String(req.query.imageKey);
      if (req.query?.runtime) filter.runtime = String(req.query.runtime);
      const sandboxes = await listSandboxes(filter);
      return res.json({ _version: 1, sandboxes, count: sandboxes.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountAgentSandboxRoutes;
