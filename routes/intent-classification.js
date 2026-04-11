/**
 * Phase 62.1: Intent classification routes.
 *
 * POST /api/v1/support/intent/train-example    -- body { intent, text, extras? }
 * POST /api/v1/support/intent/train            -- body { }  (train from persisted examples)
 * POST /api/v1/support/intent/classify         -- body { text }
 * GET  /api/v1/support/intent/list             -- list all intents
 * POST /api/v1/support/intent/evaluate         -- body { testSet: [{intent, text}, ...] }
 */
import {
  addTrainingExample,
  trainIntentClassifier,
  classifyTicket,
  listIntents,
  evaluateClassifier,
} from "../lib/intent-classification.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "intent-classification error");
}

export function mountIntentClassificationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/support/intent/train-example", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.intent || typeof body.intent !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "intent is required");
      }
      if (!body.text || typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const extras = body.extras && typeof body.extras === "object" ? body.extras : {};
      const ex = await addTrainingExample(body.intent, body.text, extras);
      return res.status(201).json({ _version: 1, example: ex });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/support/intent/train", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const examples = Array.isArray(body.examples) ? body.examples : undefined;
      const model = await trainIntentClassifier({ examples });
      return res.json({
        _version: 1,
        trained: true,
        intents: model.intents,
        exampleCount: model.exampleCount,
        trainedAt: model.trainedAt,
      });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/support/intent/classify", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.text || typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text is required");
      }
      const result = await classifyTicket(body.text);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/support/intent/list", log, auth, scope("read"), async (_req, res) => {
    try {
      const intents = await listIntents();
      return res.json({ _version: 1, intents, count: intents.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/support/intent/evaluate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.testSet)) {
        return apiError(res, 400, "INVALID_INPUT", "testSet array is required");
      }
      const result = await evaluateClassifier(body.testSet);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountIntentClassificationRoutes;
