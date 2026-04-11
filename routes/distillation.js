/**
 * Phase 58.4: Distillation routes.
 *
 * POST /api/v1/distillation/jobs              -- body { teacher, student, taskType?, targetTraces? }
 * GET  /api/v1/distillation/jobs              -- list all jobs
 * GET  /api/v1/distillation/jobs/:id          -- single-job status
 * POST /api/v1/distillation/jobs/:id/traces   -- body { input, output, metadata? }
 * POST /api/v1/distillation/jobs/:id/export   -- body { format?, markExported? }
 * POST /api/v1/distillation/jobs/:id/status   -- body { status }
 */
import {
  createDistillationJob,
  recordTeacherTrace,
  exportTrainingSet,
  jobStatus,
  listJobs,
  setJobStatus,
} from "../lib/distillation.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "distillation error");
}

export function mountDistillationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/distillation/jobs
  apiRoute("post", "/distillation/jobs", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const job = await createDistillationJob({
        teacher: body.teacher,
        student: body.student,
        taskType: body.taskType,
        targetTraces: body.targetTraces,
      });
      return res.status(201).json({ _version: 1, job });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/distillation/jobs
  apiRoute("get", "/distillation/jobs", log, auth, scope("read"), async (_req, res) => {
    try {
      const jobs = await listJobs();
      return res.json({ _version: 1, jobs, count: jobs.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/distillation/jobs/:id
  apiRoute("get", "/distillation/jobs/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const job = await jobStatus(req.params.id);
      if (!job) return apiError(res, 404, "NOT_FOUND", `job not found: ${req.params.id}`);
      return res.json({ _version: 1, job });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/distillation/jobs/:id/traces
  apiRoute("post", "/distillation/jobs/:id/traces", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (body.input === undefined) {
        return apiError(res, 400, "INVALID_INPUT", "input is required");
      }
      if (body.output === undefined) {
        return apiError(res, 400, "INVALID_INPUT", "output is required");
      }
      const job = await recordTeacherTrace(req.params.id, {
        input: body.input,
        output: body.output,
        metadata: body.metadata,
      });
      return res.status(201).json({ _version: 1, job });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // POST /api/v1/distillation/jobs/:id/export
  apiRoute("post", "/distillation/jobs/:id/export", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const result = await exportTrainingSet(req.params.id, {
        format: body.format === "messages" ? "messages" : "jsonl",
        markExported: Boolean(body.markExported),
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 404);
    }
  });

  // POST /api/v1/distillation/jobs/:id/status  (admin-only)
  apiRoute("post", "/distillation/jobs/:id/status", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.status || typeof body.status !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "status is required");
      }
      const job = await setJobStatus(req.params.id, body.status);
      return res.json({ _version: 1, job });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountDistillationRoutes;
