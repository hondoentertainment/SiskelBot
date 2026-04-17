/**
 * Cost estimation route for agent runs.
 *
 * POST /api/v1/agent/cost-estimate — predict the cost of an agent run
 * based on historical data and model pricing.
 */

import { predictCost } from "../lib/cost-predictor.js";

export function mountCostEstimateRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest, sanitizeWorkspace } = deps;

  apiRoute("post", "/agent/cost-estimate", logRequest, userAuth, requireScope("read"), async (req, res) => {
    const workspace = sanitizeWorkspace(req.body?.workspace || req.query?.workspace || "default");
    const { profile, model, goal } = req.body || {};

    if (!model || typeof model !== "string") {
      return apiError(res, 400, "INVALID_INPUT", "model is required and must be a string", "Provide a model name in the request body.");
    }

    const goalLength = typeof goal === "string" ? goal.length : 0;

    try {
      const prediction = predictCost({
        workspace,
        profile: profile || null,
        model,
        goalLength,
      });

      res.json(prediction);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Cost estimation failed", "See server logs.");
    }
  });
}
