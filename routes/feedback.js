/**
 * Route module: feedback collection and prompt optimization.
 *
 * POST /api/v1/feedback                — submit feedback
 * GET  /api/v1/feedback/stats          — feedback statistics
 * GET  /api/v1/feedback/export         — export feedback data
 * GET  /api/v1/feedback/insights       — prompt performance analysis
 * GET  /api/v1/feedback/suggestions    — prompt improvement suggestions
 * GET  /api/v1/feedback/ab-results     — A/B test comparison
 */

import { recordFeedback, getFeedbackStats, exportFeedback } from "../lib/feedback.js";
import { analyzePromptPerformance, suggestPromptImprovements, getABTestResults } from "../lib/prompt-optimizer.js";

export function mountFeedbackRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // POST /api/v1/feedback
  apiRoute("post", "/feedback", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { conversationId, messageIndex, rating, comment, model, prompt, response } = req.body || {};
      if (!conversationId || typeof conversationId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "conversationId is required.");
      }
      const msgIdx = Number(messageIndex);
      if (!Number.isFinite(msgIdx) || msgIdx < 0) {
        return apiError(res, 400, "INVALID_INPUT", "messageIndex must be a non-negative number.");
      }
      const numRating = Number(rating);
      if (!Number.isInteger(numRating) || numRating < 1 || numRating > 5) {
        return apiError(res, 400, "INVALID_RATING", "rating must be an integer between 1 and 5.");
      }

      const workspace = req.body?.workspace || req.query?.workspace || "default";
      const userId = req.userId || null;

      const result = await recordFeedback(conversationId, msgIdx, numRating, comment, userId, {
        workspaceId: workspace,
        model: model || null,
        prompt: typeof prompt === "string" ? prompt : null,
        response: typeof response === "string" ? response : null,
      });

      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/feedback/stats
  apiRoute("get", "/feedback/stats", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const period = req.query?.period || null;
      const stats = await getFeedbackStats(workspace, period);
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/feedback/export
  apiRoute("get", "/feedback/export", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const format = req.query?.format || "json";
      if (!["json", "csv", "jsonl"].includes(format)) {
        return apiError(res, 400, "INVALID_FORMAT", "format must be json, csv, or jsonl.");
      }
      const result = await exportFeedback(workspace, format);
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.data);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/feedback/insights
  apiRoute("get", "/feedback/insights", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const result = await analyzePromptPerformance(workspace);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/feedback/suggestions
  apiRoute("get", "/feedback/suggestions", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const result = await suggestPromptImprovements(workspace);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/feedback/ab-results
  apiRoute("get", "/feedback/ab-results", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const result = await getABTestResults(workspace);
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
