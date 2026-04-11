/**
 * Phase 55.3: Sandboxed shell agent routes.
 *
 * POST   /api/v1/shell-agent/run            -- body { cmd, root?, cwd?, timeoutMs? }
 * POST   /api/v1/shell-agent/allow-check    -- body { cmd }
 * POST   /api/v1/shell-agent/checkpoints    -- body { root, label? }
 * GET    /api/v1/shell-agent/checkpoints
 * POST   /api/v1/shell-agent/checkpoints/:id/restore
 * DELETE /api/v1/shell-agent/checkpoints/:id
 *
 * All shell operations require admin auth. The sandbox root is capped to the
 * WORKSPACE_ROOT env var unless the server is started with SHELL_AGENT_ROOT.
 */
import {
  runShellCommand,
  createCheckpoint,
  restoreCheckpoint,
  listCheckpoints,
  deleteCheckpoint,
  isCommandAllowed,
} from "../lib/shell-agent.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "shell-agent error");
}

function configuredRoot(bodyRoot) {
  if (typeof bodyRoot === "string" && bodyRoot.trim()) return bodyRoot.trim();
  const env = (process.env.SHELL_AGENT_ROOT || process.env.WORKSPACE_ROOT || "").trim();
  return env || "";
}

export function mountShellAgentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/shell-agent/run", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.cmd || typeof body.cmd !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "cmd is required");
      }
      const root = configuredRoot(body.root);
      if (!root) {
        return apiError(res, 400, "INVALID_INPUT", "sandbox root is not configured");
      }
      const result = await runShellCommand(body.cmd, {
        root,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
      });
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/shell-agent/allow-check", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.cmd !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "cmd is required");
      }
      return res.json({ _version: 1, allowed: isCommandAllowed(body.cmd) });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/shell-agent/checkpoints", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const root = configuredRoot(body.root);
      if (!root) {
        return apiError(res, 400, "INVALID_INPUT", "root is required");
      }
      const cp = await createCheckpoint(root, typeof body.label === "string" ? body.label : "");
      return res.status(201).json({ _version: 1, checkpoint: cp });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/shell-agent/checkpoints", log, admin, async (_req, res) => {
    try {
      const list = await listCheckpoints();
      return res.json({ _version: 1, checkpoints: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/shell-agent/checkpoints/:id/restore", log, admin, async (req, res) => {
    try {
      const r = await restoreCheckpoint(req.params.id);
      return res.json({ _version: 1, restored: r });
    } catch (err) {
      return sendError(apiError, res, err, 404);
    }
  });

  apiRoute("delete", "/shell-agent/checkpoints/:id", log, admin, async (req, res) => {
    try {
      const ok = await deleteCheckpoint(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", "checkpoint not found");
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountShellAgentRoutes;
