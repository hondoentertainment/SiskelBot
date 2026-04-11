/**
 * Phase 61.4: Local dev environment routes.
 *
 * POST /api/v1/devenv/manifest  -- body { manifest } (load)
 * POST /api/v1/devenv/seed      -- body { name?, type?, data? }
 * POST /api/v1/devenv/start     -- body { names? }
 * POST /api/v1/devenv/stop      -- body { names? }
 * GET  /api/v1/devenv/status
 */
import {
  loadManifest,
  seedData,
  startServices,
  stopServices,
  getDevStatus,
} from "../lib/local-dev-env.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "local-dev-env error");
}

export function mountLocalDevEnvRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/devenv/manifest", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.manifest) {
        return apiError(res, 400, "INVALID_INPUT", "manifest is required");
      }
      const manifest = await loadManifest(body.manifest);
      return res.status(201).json({ _version: 1, manifest });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/devenv/seed", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      // The HTTP path intentionally does not inject a writer; seedData
      // uses its default "applied" callback. Operators supply a custom
      // applyHook via server-side code if they want real seeding.
      const result = await seedData({
        name: typeof body.name === "string" ? body.name : undefined,
        type: typeof body.type === "string" ? body.type : undefined,
        data: body.data,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/devenv/start", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await startServices({
        names: Array.isArray(body.names) ? body.names : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/devenv/stop", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await stopServices({
        names: Array.isArray(body.names) ? body.names : undefined,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/devenv/status", log, auth, scope("read"), async (_req, res) => {
    try {
      const status = await getDevStatus();
      return res.json({ _version: 1, ...status });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountLocalDevEnvRoutes;
