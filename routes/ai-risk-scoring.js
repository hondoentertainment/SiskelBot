/**
 * Route module: AI risk scoring (Phase 65.5).
 *
 * POST  /api/v1/ai-risk/scores                  — scoreModel
 * GET   /api/v1/ai-risk/scores                  — listScores
 * GET   /api/v1/ai-risk/scores/:modelId         — getScore
 * GET   /api/v1/ai-risk/rmf-coverage            — getRmfCoverage
 */
import {
  scoreModel,
  getScore,
  listScores,
  getRmfCoverage,
} from "../lib/ai-risk-scoring.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "") || /must include/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountAiRiskScoringRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/ai-risk/scores", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await scoreModel(body.modelId, {
        scores: body.scores,
        reviewer: body.reviewer,
        rationale: body.rationale,
        weights: body.weights,
        evidence: body.evidence,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/ai-risk/scores", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.level) filter.level = String(req.query.level);
      if (req.query?.minOverall) filter.minOverall = Number(req.query.minOverall);
      if (req.query?.maxOverall) filter.maxOverall = Number(req.query.maxOverall);
      const scores = await listScores(filter);
      res.json({ scores });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/ai-risk/rmf-coverage", adminAuth, logRequest, async (req, res) => {
    try {
      const coverage = await getRmfCoverage();
      res.json(coverage);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/ai-risk/scores/:modelId", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getScore(req.params.modelId);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "score not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountAiRiskScoringRoutes;
