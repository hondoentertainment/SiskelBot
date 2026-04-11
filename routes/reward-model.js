/**
 * Phase 56.5: Reward model routes.
 *
 * POST /api/v1/reward-model/preferences  -- collect a pair
 * POST /api/v1/reward-model/train        -- train the model
 * POST /api/v1/reward-model/predict      -- predict reward for text
 * GET  /api/v1/reward-model/export       -- export the model
 * POST /api/v1/reward-model/import       -- import a model (admin)
 */
import {
  collectPreference,
  trainRewardModel,
  predictReward,
  exportModel,
  importModel,
  countPreferences,
} from "../lib/reward-model.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "reward-model error");
}

export function mountRewardModelRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/reward-model/preferences", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await collectPreference({
        chosen: body.chosen,
        rejected: body.rejected,
        context: body.context,
        rater: body.rater,
      });
      return res.status(201).json({ _version: 1, preference: rec, total: await countPreferences() });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/reward-model/train", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const model = await trainRewardModel({
        epochs: body.epochs,
        lr: body.lr,
        dim: body.dim,
        l2: body.l2,
      });
      // Don't stream huge weight arrays back to the caller.
      return res.json({
        _version: 1,
        model: {
          dim: model.dim,
          trainedAt: model.trainedAt,
          epochs: model.epochs,
          preferenceCount: model.preferenceCount,
          accuracy: model.accuracy,
          finalLoss: model.finalLoss,
          lossHistory: model.lossHistory,
        },
      });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/reward-model/predict", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text required");
      }
      const reward = await predictReward(body.text);
      return res.json({ _version: 1, reward });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/reward-model/export", log, admin, async (_req, res) => {
    try {
      const model = await exportModel();
      return res.json({ _version: 1, model });
    } catch (err) {
      const status = /no trained model/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/reward-model/import", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.model) {
        return apiError(res, 400, "INVALID_INPUT", "model required");
      }
      const m = await importModel(body.model);
      return res.json({ _version: 1, model: { dim: m.dim, trainedAt: m.trainedAt, accuracy: m.accuracy } });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountRewardModelRoutes;
