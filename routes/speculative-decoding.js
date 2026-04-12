/**
 * Phase 58.2: Speculative decoding routes.
 *
 * POST /api/v1/speculative/generate   — body: { prompt, options }
 * POST /api/v1/speculative/batch      — body: { prompts, options }
 * GET  /api/v1/speculative/stats      — aggregate stats (optional since/until/workspace)
 * GET  /api/v1/speculative/runs       — list runs (optional filters)
 * GET  /api/v1/speculative/runs/:id   — single run record
 * GET  /api/v1/speculative/presets    — preset list
 * POST /api/v1/speculative/estimate   — body: { acceptanceRate, gamma, targetLatencyMs, draftLatencyMs }
 */
import {
  speculativeGenerate,
  batchedSpeculativeGenerate,
  recordRun,
  getRunHistory,
  getAggregateStats,
  computeExpectedTokensPerIteration,
  computeSpeedup,
  PRESETS,
  listRegisteredModels,
} from "../lib/speculative-decoding.js";

export function mountSpeculativeDecodingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  const readAuth = [];
  const writeAuth = [];
  if (chatAuth) readAuth.push(chatAuth);
  if (chatAuth) writeAuth.push(chatAuth);
  if (requireScope) readAuth.push(requireScope("read"));
  if (requireScope) writeAuth.push(requireScope("write"));

  // POST /api/v1/speculative/generate
  apiRoute("post", "/speculative/generate", ...writeAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const prompt = typeof body.prompt === "string" ? body.prompt : null;
      if (!prompt) {
        return apiError(res, 400, "INVALID_INPUT", "prompt is required");
      }
      const options = body.options && typeof body.options === "object" ? body.options : {};
      const result = await speculativeGenerate(prompt, options);

      // Persist the run so it shows up in history/stats
      const workspaceId = body.workspaceId || req.query?.workspace || "default";
      const record = await recordRun({
        workspaceId,
        draftModel: typeof options.draftModel === "string" ? options.draftModel : "mock",
        targetModel: typeof options.targetModel === "string" ? options.targetModel : "mock",
        promptPreview: prompt.slice(0, 200),
        tokens: result.tokens.length,
        accepted: result.stats.accepted,
        rejected: result.stats.rejected,
        iterations: result.stats.iterations,
        gamma: result.stats.gamma,
        acceptanceRate: result.stats.acceptanceRate,
        speedupEstimate: result.stats.speedupEstimate,
        durationMs: result.stats.durationMs,
        stopReason: result.stats.stopReason,
        metadata: body.metadata || {},
      });

      res.json({ ...result, runId: record.id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/speculative/batch
  apiRoute("post", "/speculative/batch", ...writeAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const prompts = Array.isArray(body.prompts) ? body.prompts : null;
      if (!prompts || prompts.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "prompts array is required");
      }
      const options = body.options && typeof body.options === "object" ? body.options : {};
      const out = await batchedSpeculativeGenerate(prompts, options);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/speculative/stats
  apiRoute("get", "/speculative/stats", ...readAuth, logRequest, async (req, res) => {
    try {
      const stats = await getAggregateStats({
        since: req.query?.since,
        until: req.query?.until,
        workspaceId: req.query?.workspace,
      });
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/speculative/runs
  apiRoute("get", "/speculative/runs", ...readAuth, logRequest, async (req, res) => {
    try {
      const limit = Number(req.query?.limit || 100);
      const runs = await getRunHistory({
        workspaceId: req.query?.workspace,
        draftModel: req.query?.draftModel,
        targetModel: req.query?.targetModel,
        since: req.query?.since,
        until: req.query?.until,
        limit: Number.isFinite(limit) ? limit : 100,
      });
      res.json({ runs, count: runs.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/speculative/runs/:id
  apiRoute("get", "/speculative/runs/:id", ...readAuth, logRequest, async (req, res) => {
    try {
      const id = req.params?.id;
      if (!id) return apiError(res, 400, "INVALID_INPUT", "id is required");
      const matches = await getRunHistory({ id });
      if (matches.length === 0) {
        return apiError(res, 404, "NOT_FOUND", "run not found");
      }
      res.json(matches[0]);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/speculative/presets
  apiRoute("get", "/speculative/presets", ...readAuth, logRequest, (req, res) => {
    try {
      res.json({ presets: PRESETS, models: listRegisteredModels() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/speculative/estimate
  apiRoute("post", "/speculative/estimate", ...readAuth, logRequest, (req, res) => {
    try {
      const body = req.body || {};
      const acceptanceRate = Number(body.acceptanceRate);
      const gamma = Number(body.gamma || 4);
      if (!Number.isFinite(acceptanceRate) || acceptanceRate < 0 || acceptanceRate > 1) {
        return apiError(res, 400, "INVALID_INPUT", "acceptanceRate must be between 0 and 1");
      }
      const targetLatencyMs = Number(body.targetLatencyMs || body.latencyMs || 0);
      const draftLatencyMs = Number(body.draftLatencyMs || 0);
      const expectedTokensPerIteration = computeExpectedTokensPerIteration(acceptanceRate, gamma);
      const speedup = computeSpeedup(
        { accepted: acceptanceRate * 100, rejected: (1 - acceptanceRate) * 100, gamma },
        targetLatencyMs,
        draftLatencyMs,
      );
      res.json({
        acceptanceRate,
        gamma,
        targetLatencyMs,
        draftLatencyMs,
        expectedTokensPerIteration,
        estimatedSpeedup: speedup,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountSpeculativeDecodingRoutes;
