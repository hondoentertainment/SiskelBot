/**
 * Continuous learning routes.
 * GET  /api/v1/learning/stats
 * GET  /api/v1/learning/training-candidates
 * POST /api/v1/learning/curate
 * GET  /api/v1/learning/drift
 * GET  /api/v1/learning/propose-training
 * POST /api/v1/learning/interactions/:id/signal
 * POST /api/v1/learning/interactions            — record interaction (internal/test)
 */
import {
  getLearningStats,
  listTrainingCandidates,
  curateTrainingData,
  detectDrift,
  proposeTrainingRun,
  recordSignal,
  recordInteraction,
} from "../lib/continuous-learning.js";
import { runCurationCycle } from "../lib/continuous-learning-worker.js";

export function mountContinuousLearningRoutes(app, deps) {
  const { apiRoute, apiError, sanitizeWorkspace, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());

  const ws = (req) =>
    (sanitizeWorkspace && sanitizeWorkspace(req.query?.workspace || req.body?.workspace)) ||
    req.query?.workspace ||
    req.body?.workspace ||
    "default";

  // GET /api/v1/learning/stats
  apiRoute("get", "/learning/stats", limiter, async (req, res) => {
    try {
      const stats = await getLearningStats(ws(req));
      res.json({ _version: 1, ...stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learning/training-candidates
  apiRoute("get", "/learning/training-candidates", limiter, async (req, res) => {
    try {
      const limit = req.query?.limit ? Number(req.query.limit) : 50;
      const result = await listTrainingCandidates(ws(req), { limit });
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/learning/curate — trigger a curation cycle immediately
  apiRoute("post", "/learning/curate", limiter, async (req, res) => {
    try {
      const result = await runCurationCycle(ws(req));
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learning/curate/preview — preview without mutating state
  apiRoute("get", "/learning/curate/preview", limiter, async (req, res) => {
    try {
      const minScore = req.query?.minScore ? Number(req.query.minScore) : undefined;
      const maxExamples = req.query?.maxExamples ? Number(req.query.maxExamples) : undefined;
      const result = await curateTrainingData(ws(req), { minScore, maxExamples });
      res.json({
        _version: 1,
        count: result.count,
        rejected: result.rejected,
        candidates: result.candidates,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learning/drift
  apiRoute("get", "/learning/drift", limiter, async (req, res) => {
    try {
      const drift = await detectDrift(ws(req));
      res.json({ _version: 1, ...drift });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learning/propose-training
  apiRoute("get", "/learning/propose-training", limiter, async (req, res) => {
    try {
      const proposal = await proposeTrainingRun(ws(req));
      res.json({ _version: 1, ...proposal });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/learning/interactions/:id/signal
  apiRoute("post", "/learning/interactions/:id/signal", limiter, async (req, res) => {
    try {
      const { type, value } = req.body || {};
      if (!type) {
        return apiError(res, 400, "INVALID_INPUT", "signal type is required");
      }
      const result = await recordSignal(ws(req), req.params.id, { type, value });
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/type|interactionId/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/learning/interactions — record a new interaction
  apiRoute("post", "/learning/interactions", limiter, async (req, res) => {
    try {
      const { prompt, response, model, rating, metadata, conversationId } = req.body || {};
      if (!prompt || !response) {
        return apiError(res, 400, "INVALID_INPUT", "prompt and response are required");
      }
      const result = await recordInteraction({
        workspaceId: ws(req),
        prompt,
        response,
        model,
        rating,
        metadata,
        conversationId,
        userId: req.userId || "anonymous",
      });
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/required/.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountContinuousLearningRoutes;
