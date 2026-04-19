/**
 * Admin routes for the quality-jobs scheduler.
 *
 * Surfaces lib/agent-quality-scheduler.js: list, inspect, run-now, toggle
 * enabled, and start/stop the whole loop. All routes require admin auth and
 * the "admin" scope.
 *
 * Mounted at /api/admin/quality-jobs/*.
 */

import {
  listJobs,
  getJob,
  runJobNow,
  setJobEnabled,
  startJobs,
  stopJobs,
} from "../lib/agent-quality-scheduler.js";

export default function mountAdminQualityJobsRoutes(app, deps) {
  const { apiError, logRequest, adminAuth, requireScope } = deps;

  /** GET /api/admin/quality-jobs */
  app.get(
    "/api/admin/quality-jobs",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (_req, res) => {
      try {
        const jobs = listJobs();
        return res.json({ jobs });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/quality-jobs/start */
  app.post(
    "/api/admin/quality-jobs/start",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (_req, res) => {
      try {
        await startJobs();
        return res.json({ ok: true, running: true, jobs: listJobs() });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/quality-jobs/stop */
  app.post(
    "/api/admin/quality-jobs/stop",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (_req, res) => {
      try {
        await stopJobs();
        return res.json({ ok: true, running: false });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** GET /api/admin/quality-jobs/:name */
  app.get(
    "/api/admin/quality-jobs/:name",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const name = String(req.params.name || "");
        const job = getJob(name);
        if (!job) return apiError(res, 404, "NOT_FOUND", `unknown job: ${name}`);
        return res.json({ job });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/quality-jobs/:name/run */
  app.post(
    "/api/admin/quality-jobs/:name/run",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const name = String(req.params.name || "");
        const job = getJob(name);
        if (!job) return apiError(res, 404, "NOT_FOUND", `unknown job: ${name}`);
        const outcome = await runJobNow(name);
        return res.json({ name, ...outcome, job: getJob(name) });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /** POST /api/admin/quality-jobs/:name/enable  body: {enabled: true|false} */
  app.post(
    "/api/admin/quality-jobs/:name/enable",
    adminAuth,
    requireScope("admin"),
    logRequest,
    async (req, res) => {
      try {
        const name = String(req.params.name || "");
        const body = req.body || {};
        if (typeof body.enabled !== "boolean") {
          return apiError(res, 400, "BAD_REQUEST", "body.enabled must be boolean");
        }
        const job = getJob(name);
        if (!job) return apiError(res, 404, "NOT_FOUND", `unknown job: ${name}`);
        const updated = await setJobEnabled(name, body.enabled);
        return res.json({ job: updated });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}
