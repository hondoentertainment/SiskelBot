/**
 * Phase 63.2: PR review routes.
 */
import {
  reviewDiff,
  listSuggestions,
  applySuggestion,
  dismissSuggestion,
  listRules,
  listReviews,
} from "../lib/pr-review.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "pr-review error");
}

export function mountPrReviewRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/code/pr-review/review", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.diff !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "diff string required");
      }
      const out = await reviewDiff(body.diff, body);
      return res.status(201).json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/code/pr-review/rules", log, auth, scope("read"), async (_req, res) => {
    try {
      return res.json({ _version: 1, rules: listRules() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/code/pr-review/reviews", log, auth, scope("read"), async (_req, res) => {
    try {
      const reviews = await listReviews();
      return res.json({ _version: 1, reviews, count: reviews.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/code/pr-review/reviews/:id/suggestions", log, auth, scope("read"), async (req, res) => {
    try {
      const list = await listSuggestions(req.params.id);
      return res.json({ _version: 1, suggestions: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/code/pr-review/suggestions/:id/apply", log, auth, scope("write"), async (req, res) => {
    try {
      const out = await applySuggestion(req.params.id);
      if (!out) return apiError(res, 404, "NOT_FOUND", "suggestion not found");
      return res.json({ _version: 1, suggestion: out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/code/pr-review/suggestions/:id/dismiss", log, auth, scope("write"), async (req, res) => {
    try {
      const out = await dismissSuggestion(req.params.id);
      if (!out) return apiError(res, 404, "NOT_FOUND", "suggestion not found");
      return res.json({ _version: 1, suggestion: out });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountPrReviewRoutes;
