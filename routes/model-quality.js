/**
 * Route module: model quality and ranking endpoints.
 *
 * GET  /api/v1/models/quality          — quality scores for all models
 * GET  /api/v1/models/ranking          — ranked list
 * GET  /api/v1/models/:model/quality/history?period=7d — quality over time
 * PUT  /api/v1/models/:model/rating    — user rating (1-5)
 */

export function mountModelQualityRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    getModelRanking,
    getModelQuality,
    getQualityHistory,
    recordModelResponse,
  } = deps;

  // GET /api/v1/models/quality
  apiRoute("get", "/models/quality", logRequest, (req, res) => {
    try {
      const ranking = getModelRanking();
      const result = {};
      for (const entry of ranking) {
        result[entry.model] = {
          score: entry.score,
          latencyP50: entry.latencyP50,
          latencyP95: entry.latencyP95,
          errorRate: entry.errorRate,
          throughput: entry.throughput,
          sampleCount: entry.sampleCount,
        };
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/ranking
  apiRoute("get", "/models/ranking", logRequest, (req, res) => {
    try {
      const ranking = getModelRanking();
      res.json(ranking);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/:model/quality/history?period=7d
  apiRoute("get", "/models/:model/quality/history", logRequest, (req, res) => {
    try {
      const model = req.params.model;
      const period = req.query?.period || "7d";
      const history = getQualityHistory(model, period);
      const quality = getModelQuality(model);
      res.json({ model, period, current: quality, history });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // PUT /api/v1/models/:model/rating
  apiRoute("put", "/models/:model/rating", logRequest, (req, res) => {
    try {
      const model = req.params.model;
      const rating = Number(req.body?.rating);
      if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
        return apiError(res, 400, "INVALID_RATING", "Rating must be a number between 1 and 5.");
      }
      recordModelResponse(model, { latencyMs: 0, tokens: 0, error: false, rating });
      const quality = getModelQuality(model);
      res.json({ model, rating, quality });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}
