/**
 * Phase 75.2: Judge calibration routes.
 *
 * POST /judge-calibration/judgements          — record a judgement
 * GET  /judge-calibration/judges              — list known judges
 * GET  /judge-calibration/:judgeId/stats      — precision/recall/F1/accuracy
 * GET  /judge-calibration/:judgeId/matrix     — confusion matrix
 * GET  /judge-calibration/:judgeId/judgements — list judgements (paginated)
 */
import {
  recordJudgement,
  computeCalibration,
  getConfusionMatrix,
  listJudges,
  listJudgements,
} from "../lib/judge-calibration.js";

export function mountJudgeCalibrationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/judge-calibration/judgements", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await recordJudgement(body);
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/judge-calibration/judges", adminAuth, logRequest, async (_req, res) => {
    try {
      const list = await listJudges();
      res.json({ judges: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/judge-calibration/:judgeId/stats", adminAuth, logRequest, async (req, res) => {
    try {
      const stats = await computeCalibration(req.params.judgeId);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/judge-calibration/:judgeId/matrix", adminAuth, logRequest, async (req, res) => {
    try {
      const matrix = await getConfusionMatrix(req.params.judgeId);
      res.json(matrix);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/judge-calibration/:judgeId/judgements", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await listJudgements({
        judgeId: req.params.judgeId,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountJudgeCalibrationRoutes;
