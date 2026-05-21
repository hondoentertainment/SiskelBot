/**
 * Phase 63.2: PR review agent routes.
 */
import {
  reviewDiff,
  getReview,
  listReviews,
  BUILTIN_RULES,
} from "../lib/pr-review-agent.js";
import { meterPhase63Operation } from "../lib/phase63-metering.js";

export function mountPrReviewRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/pr-review/review", adminAuth, logRequest, async (req, res) => {
    try {
      const { workspaceId, diff, rules } = req.body || {};
      if (typeof diff !== "string" || !diff.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "diff is required");
      }
      const review = await reviewDiff({ workspaceId, diff, rules });
      await meterPhase63Operation({
        workspaceId,
        feature: "pr-review",
        calls: 1,
        units: (review.comments || []).length,
        tags: { reviewId: review.reviewId },
      });
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
}

export default mountPrReviewRoutes;
