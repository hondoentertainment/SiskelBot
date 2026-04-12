/**
 * Route module: continuous profiling (Phase 60.1).
 *
 * POST   /api/v1/profiling/start            — start a new profile
 * POST   /api/v1/profiling/stop             — stop active profile
 * POST   /api/v1/profiling/abort            — abort without saving full tree
 * GET    /api/v1/profiling/status           — active profile status (if any)
 * GET    /api/v1/profiling/profiles         — list saved profiles
 * GET    /api/v1/profiling/profiles/:id     — fetch one
 *
 * All routes require an admin-scoped API key.
 */

import {
  startProfiler,
  stopProfiler,
  abortProfiler,
  getProfile,
  listProfiles,
  getActiveProfileStatus,
} from "../lib/profiling.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (err?.code === "ALREADY_RUNNING") return { status: 409, code: "ALREADY_RUNNING" };
  if (/required/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountProfilingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /api/v1/profiling/start
  apiRoute("post", "/profiling/start", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const profile = startProfiler({
        intervalMs: body.intervalMs,
        durationMs: body.durationMs,
        label: body.label,
      });
      res.status(201).json(profile);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/profiling/stop
  apiRoute("post", "/profiling/stop", adminAuth, logRequest, async (req, res) => {
    try {
      const record = await stopProfiler();
      res.json(record);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/profiling/abort
  apiRoute("post", "/profiling/abort", adminAuth, logRequest, async (req, res) => {
    try {
      const record = await abortProfiler();
      if (!record) return apiError(res, 404, "NOT_FOUND", "no active profiler");
      res.json(record);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/profiling/status
  apiRoute("get", "/profiling/status", adminAuth, logRequest, async (req, res) => {
    try {
      const status = getActiveProfileStatus();
      res.json(status || { active: false });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/profiling/profiles
  apiRoute("get", "/profiling/profiles", adminAuth, logRequest, async (req, res) => {
    try {
      const profiles = await listProfiles();
      res.json({ profiles });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/profiling/profiles/:id
  apiRoute("get", "/profiling/profiles/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const profile = await getProfile(req.params.id);
      if (!profile) return apiError(res, 404, "NOT_FOUND", "profile not found");
      res.json(profile);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountProfilingRoutes;
