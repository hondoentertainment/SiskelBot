/**
 * Route module: source credibility (Phase 68.4).
 *
 * POST   /api/v1/source-credibility/score          — scoreSource
 * POST   /api/v1/source-credibility/override       — updateScore (manual override/penalty)
 * GET    /api/v1/source-credibility                — listScores
 * GET    /api/v1/source-credibility/:sourceKey     — getScore
 */
import {
  scoreSource,
  updateScore,
  getScore,
  listScores,
} from "../lib/source-credibility.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountSourceCredibilityRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/source-credibility/score", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await scoreSource(body.sourceKey, {
        citationCount: body.citationCount,
        ageDays: body.ageDays,
        updateFrequencyDays: body.updateFrequencyDays,
        manualOverride: body.manualOverride,
        penalties: body.penalties,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/source-credibility/override", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await updateScore(body.sourceKey, {
        manualOverride: body.manualOverride,
        penalties: body.penalties,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/source-credibility", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.level) filter.level = String(req.query.level);
      if (req.query?.minScore) filter.minScore = Number(req.query.minScore);
      if (req.query?.maxScore) filter.maxScore = Number(req.query.maxScore);
      const scores = await listScores(filter);
      res.json({ scores });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/source-credibility/:sourceKey", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getScore(req.params.sourceKey);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "source not scored");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountSourceCredibilityRoutes;
