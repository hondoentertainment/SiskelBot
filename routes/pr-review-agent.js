/**
 * Phase 63.2: PR review agent routes.
 */
import {
  reviewDiff,
  getReview,
  listReviews,
  BUILTIN_RULES,
} from "../lib/pr-review-agent.js";
import {
  requestPublication,
  inspectPublication,
  consumePublication,
  SUPPORTED_TARGETS,
} from "../lib/pr-review-publish.js";

export function mountPrReviewRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/pr-review/review", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, diff, rules } = req.body || {};
      if (typeof diff !== "string" || !diff.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "diff is required");
      }
      const review = await reviewDiff({ workspaceId, diff, rules });
      res.status(201).json(review);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/pr-review/reviews", adminAuth, logRequest, async (req, res) => {
    try {
      const out = await listReviews(req.query?.workspaceId);
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/pr-review/reviews/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const review = await getReview(req.params?.id, req.query?.workspaceId);
      if (!review) return apiError(res, 404, "NOT_FOUND", "review not found");
      res.json(review);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/pr-review/rules", adminAuth, logRequest, async (_req, res) => {
    try {
      res.json({ rules: BUILTIN_RULES });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute(
    "post",
    "/pr-review/publish/request",
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const { reviewId, workspaceId, target, requestedBy } = req.body || {};
        const out = await requestPublication({
          reviewId,
          workspaceId,
          target: target || "draft-only",
          requestedBy,
        });
        res.status(201).json(out);
      } catch (err) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
    }
  );

  apiRoute(
    "get",
    "/pr-review/publish/pending/:token",
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const out = inspectPublication(req.params?.token);
        if (!out) return apiError(res, 404, "NOT_FOUND", "no pending publication for token");
        res.json(out);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  apiRoute(
    "post",
    "/pr-review/publish/approve",
    adminAuth,
    logRequest,
    async (req, res) => {
      try {
        const { token, decision } = req.body || {};
        const out = consumePublication(token, { decision });
        if (!out) return apiError(res, 404, "NOT_FOUND", "token missing or expired");
        res.json(out);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    }
  );

  apiRoute(
    "get",
    "/pr-review/publish/targets",
    adminAuth,
    logRequest,
    async (_req, res) => {
      res.json({ targets: SUPPORTED_TARGETS });
    }
  );
}

export default mountPrReviewRoutes;
