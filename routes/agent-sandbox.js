/**
 * Phase 56.1: Agent sandbox routes.
 *
 * POST   /api/v1/agent-sandboxes            -- create sandbox
 * GET    /api/v1/agent-sandboxes            -- list sandboxes
 * GET    /api/v1/agent-sandboxes/:id        -- fetch a sandbox
 * POST   /api/v1/agent-sandboxes/:id/run    -- run a command
 * PATCH  /api/v1/agent-sandboxes/:id/limits -- update resource limits
 * DELETE /api/v1/agent-sandboxes/:id        -- destroy sandbox
 * GET    /api/v1/agent-sandboxes/policy/images     -- list allowed images
 * PUT    /api/v1/agent-sandboxes/policy/images     -- replace allowed images (admin)
 */
import {
  createSandbox,
  runInSandbox,
  destroySandbox,
  listSandboxes,
  getSandbox,
  setResourceLimits,
  getAllowedImages,
  setAllowedImages,
} from "../lib/agent-sandbox.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "agent-sandbox error");
}

export function mountAgentSandboxRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/agent-sandboxes", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.image || typeof body.image !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "image is required");
      }
      const rec = await createSandbox({
        image: body.image,
        name: body.name,
        limits: body.limits,
        metadata: body.metadata,
        allowedImages: Array.isArray(body.allowedImages) ? body.allowedImages : undefined,
      });
      return res.status(201).json({ _version: 1, sandbox: rec });
    } catch (err) {
      const status = /not in the allowed|required/i.test(err?.message || "") ? 400 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/agent-sandboxes", log, auth, scope("read"), async (req, res) => {
    try {
      const state = typeof req.query.state === "string" ? req.query.state : undefined;
      const list = await listSandboxes(state ? { state } : {});
      return res.json({ _version: 1, sandboxes: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/agent-sandboxes/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const rec = await getSandbox(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", `sandbox "${req.params.id}" not found`);
      return res.json({ _version: 1, sandbox: rec });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/agent-sandboxes/:id/run", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.command) {
        return apiError(res, 400, "INVALID_INPUT", "command is required");
      }
      const result = await runInSandbox(req.params.id, body.command, {
        cwd: body.cwd,
        env: body.env && typeof body.env === "object" ? body.env : undefined,
      });
      return res.json({ _version: 1, result });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404
        : /required|destroyed/i.test(err?.message || "") ? 400 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("patch", "/agent-sandboxes/:id/limits", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body || typeof body !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "limits body required");
      }
      const rec = await setResourceLimits(req.params.id, body);
      return res.json({ _version: 1, sandbox: rec });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404
        : /required|destroyed/i.test(err?.message || "") ? 400 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("delete", "/agent-sandboxes/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await destroySandbox(req.params.id);
      return res.json({ _version: 1, sandbox: rec });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/agent-sandboxes/policy/images", log, auth, scope("read"), async (_req, res) => {
    try {
      const imgs = await getAllowedImages();
      return res.json({ _version: 1, images: imgs });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("put", "/agent-sandboxes/policy/images", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.images)) {
        return apiError(res, 400, "INVALID_INPUT", "images array required");
      }
      const imgs = await setAllowedImages(body.images);
      return res.json({ _version: 1, images: imgs });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountAgentSandboxRoutes;
