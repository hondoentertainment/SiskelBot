/**
 * Phase 69.5: Opt-in fine-tune routes.
 */
import {
  recordConsent,
  startFineTuneJob,
  getJobStatus,
  listJobs,
  revokeConsent,
  advanceJob,
} from "../lib/optin-finetune.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "optin-finetune error");
}

export function mountOptinFinetuneRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/finetune/consent/:userId", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await recordConsent(req.params.userId, req.body || {});
      return res.status(201).json({ _version: 1, consent: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("delete", "/finetune/consent/:userId", log, auth, scope("write"), async (req, res) => {
    try {
      const r = await revokeConsent(req.params.userId);
      return res.json({ _version: 1, ...r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/finetune/jobs/:userId", log, auth, scope("write"), async (req, res) => {
    try {
      const job = await startFineTuneJob(req.params.userId, req.body || {});
      return res.status(201).json({ _version: 1, job });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/finetune/jobs/:jobId", log, auth, scope("read"), async (req, res) => {
    try {
      const job = await getJobStatus(req.params.jobId);
      if (!job) return apiError(res, 404, "NOT_FOUND", "job not found");
      return res.json({ _version: 1, job });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/finetune/jobs", log, auth, scope("read"), async (req, res) => {
    try {
      const userId = typeof req.query?.userId === "string" ? req.query.userId : undefined;
      const status = typeof req.query?.status === "string" ? req.query.status : undefined;
      const jobs = await listJobs({ userId, status });
      return res.json({ _version: 1, jobs, count: jobs.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/finetune/jobs/:jobId/advance", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const job = await advanceJob(req.params.jobId, body.status, body);
      return res.json({ _version: 1, job });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountOptinFinetuneRoutes;
