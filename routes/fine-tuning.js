/**
 * Route module: fine-tuning workflow.
 *
 * POST   /api/v1/fine-tune/export         — export conversations to JSONL
 * POST   /api/v1/fine-tune/jobs           — create fine-tune job
 * GET    /api/v1/fine-tune/jobs           — list jobs
 * GET    /api/v1/fine-tune/jobs/:id       — get job status
 * DELETE /api/v1/fine-tune/jobs/:id       — cancel a job
 * GET    /api/v1/fine-tune/jobs/:id/events — streaming events (JSON for now)
 * POST   /api/v1/fine-tune/validate       — validate JSONL training data
 */

import {
  exportConversationsForFineTuning,
  createFineTuneJob,
  listFineTuneJobs,
  getFineTuneJob,
  cancelFineTuneJob,
  getFineTuneEvents,
  validateTrainingData,
} from "../lib/fine-tuning.js";

export function mountFineTuningRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope, sanitizeWorkspace } = deps;
  const wsOf = (req) => {
    const raw = req.body?.workspace || req.query?.workspace || "default";
    return typeof sanitizeWorkspace === "function" ? sanitizeWorkspace(raw) : String(raw);
  };

  // POST /api/v1/fine-tune/export
  apiRoute(
    "post",
    "/fine-tune/export",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = wsOf(req);
        const {
          format = "openai",
          minRating = null,
          dateFrom = null,
          dateTo = null,
          maxExamples,
        } = req.body || {};

        if (!["openai", "alpaca", "sharegpt"].includes(String(format).toLowerCase())) {
          return apiError(res, 400, "INVALID_FORMAT", "format must be openai, alpaca, or sharegpt.");
        }
        if (minRating != null) {
          const n = Number(minRating);
          if (!Number.isFinite(n) || n < 1 || n > 5) {
            return apiError(res, 400, "INVALID_INPUT", "minRating must be between 1 and 5.");
          }
        }

        const result = await exportConversationsForFineTuning(workspace, {
          format,
          minRating,
          dateFrom,
          dateTo,
          maxExamples,
        });

        if (req.query?.download === "1") {
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="fine-tune-${workspace}-${format}.jsonl"`,
          );
          return res.send(result.jsonl);
        }
        return res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/fine-tune/jobs
  apiRoute(
    "post",
    "/fine-tune/jobs",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = wsOf(req);
        const { model, trainingFile, validationFile, hyperparameters, suffix, provider } = req.body || {};
        if (!model || typeof model !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "model is required.");
        }
        if (!trainingFile || typeof trainingFile !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "trainingFile is required (JSONL contents).");
        }
        const result = await createFineTuneJob(workspace, {
          provider: provider || "openai",
          model,
          trainingFile,
          validationFile,
          hyperparameters,
          suffix,
        });
        return res.status(201).json(result);
      } catch (err) {
        const msg = err.message || String(err);
        if (msg.includes("OPENAI_API_KEY")) {
          return apiError(res, 400, "MISSING_API_KEY", msg);
        }
        return apiError(res, 500, "INTERNAL_ERROR", msg);
      }
    },
  );

  // GET /api/v1/fine-tune/jobs
  apiRoute(
    "get",
    "/fine-tune/jobs",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = wsOf(req);
        const items = await listFineTuneJobs(workspace);
        return res.json({ _version: 1, items });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/fine-tune/jobs/:id
  apiRoute(
    "get",
    "/fine-tune/jobs/:id",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = wsOf(req);
        const record = await getFineTuneJob(req.params.id, { workspaceId: workspace });
        if (!record) return apiError(res, 404, "NOT_FOUND", "fine-tune job not found.");
        return res.json(record);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // DELETE /api/v1/fine-tune/jobs/:id
  apiRoute(
    "delete",
    "/fine-tune/jobs/:id",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = wsOf(req);
        const result = await cancelFineTuneJob(req.params.id, { workspaceId: workspace });
        return res.json(result);
      } catch (err) {
        const msg = err.message || String(err);
        if (msg.includes("not found")) return apiError(res, 404, "NOT_FOUND", msg);
        return apiError(res, 500, "INTERNAL_ERROR", msg);
      }
    },
  );

  // GET /api/v1/fine-tune/jobs/:id/events
  apiRoute(
    "get",
    "/fine-tune/jobs/:id/events",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const workspace = wsOf(req);
        const result = await getFineTuneEvents(req.params.id, { workspaceId: workspace });
        return res.json(result);
      } catch (err) {
        const msg = err.message || String(err);
        if (msg.includes("not found")) return apiError(res, 404, "NOT_FOUND", msg);
        return apiError(res, 500, "INTERNAL_ERROR", msg);
      }
    },
  );

  // POST /api/v1/fine-tune/validate
  apiRoute(
    "post",
    "/fine-tune/validate",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const { jsonl } = req.body || {};
        if (typeof jsonl !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "jsonl (string) is required.");
        }
        const result = validateTrainingData(jsonl);
        return res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );
}

export default mountFineTuningRoutes;
