/**
 * Phase 60.1: Continuous profiling routes.
 *
 * POST /api/v1/profiling/start       -- body { intervalMs?, durationMs?, name?, kind? }
 * POST /api/v1/profiling/stop/:id
 * GET  /api/v1/profiling/samples/:id
 * GET  /api/v1/profiling/flame/:id
 * GET  /api/v1/profiling/list
 * DELETE /api/v1/profiling/:id       -- admin only
 * DELETE /api/v1/profiling           -- admin only (clear all)
 */
import {
  startProfiler,
  stopProfiler,
  getSamples,
  getFlameData,
  clearProfile,
  listProfiles,
} from "../lib/continuous-profiling.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "profiling error");
}

export function mountContinuousProfilingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/profiling/start", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const opts = {
        intervalMs: Number.isFinite(body.intervalMs) ? body.intervalMs : undefined,
        durationMs: Number.isFinite(body.durationMs) ? body.durationMs : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
        kind: typeof body.kind === "string" ? body.kind : undefined,
        autoStart: body.autoStart === false ? false : true,
      };
      const profile = await startProfiler(opts);
      return res.status(201).json({ _version: 1, profile });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/profiling/stop/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const result = await stopProfiler(req.params.id);
      if (!result) {
        return apiError(res, 404, "NOT_FOUND", `profile ${req.params.id} not found`);
      }
      return res.json({ _version: 1, profile: result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/profiling/samples/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const result = await getSamples(req.params.id);
      if (!result) {
        return apiError(res, 404, "NOT_FOUND", `profile ${req.params.id} not found`);
      }
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/profiling/flame/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const result = await getFlameData(req.params.id);
      if (!result) {
        return apiError(res, 404, "NOT_FOUND", `profile ${req.params.id} not found`);
      }
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/profiling/list", log, auth, scope("read"), async (_req, res) => {
    try {
      const profiles = await listProfiles();
      return res.json({ _version: 1, profiles, count: profiles.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/profiling/:id", log, admin, async (req, res) => {
    try {
      const result = await clearProfile(req.params.id);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/profiling", log, admin, async (_req, res) => {
    try {
      const result = await clearProfile();
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountContinuousProfilingRoutes;
