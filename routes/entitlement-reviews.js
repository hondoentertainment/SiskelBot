/**
 * Phase 46.5: Entitlement review routes.
 *
 *   GET  /api/v1/reviews                          — list reviews (optional ?status=)
 *   POST /api/v1/reviews                          — create a new review (admin)
 *   GET  /api/v1/reviews/overdue                  — overdue open reviews
 *   GET  /api/v1/reviews/:id                      — get one review
 *   GET  /api/v1/reviews/:id/items                — items pending review
 *   POST /api/v1/reviews/:id/items/:userId/approve
 *   POST /api/v1/reviews/:id/items/:userId/revoke
 *   POST /api/v1/reviews/:id/items/:userId/change
 *   POST /api/v1/reviews/:id/complete             — finalize and apply
 *   GET  /api/v1/reviews/:id/report               — compliance report
 *   POST /api/v1/reviews/:id/remind               — send reminders to reviewers
 *   POST /api/v1/reviews/recurring                — create recurring schedule (admin)
 *   GET  /api/v1/reviews/recurring                — list recurring schedules
 */
import {
  createReview,
  listReviews,
  getReview,
  getReviewItems,
  approveAccess,
  revokeAccess,
  requestChange,
  completeReview,
  getReviewReport,
  getOverdueReviews,
  sendReviewReminders,
  scheduleRecurringReview,
  listRecurringSchedules,
} from "../lib/entitlement-reviews.js";

export function mountEntitlementReviewRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    storageRateLimiter,
    userAuth,
    adminAuth,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());
  const requireUser = userAuth || ((req, res, next) => next());
  const requireAdmin = adminAuth || ((req, res, next) => next());

  function reviewerId(req) {
    return req.user?.id || req.user?.email || req.headers["x-user-id"] || "anonymous";
  }

  // GET /api/v1/reviews
  apiRoute("get", "/reviews", limiter, requireUser, logRequest, async (req, res) => {
    try {
      const status = req.query?.status ? String(req.query.status) : null;
      const reviews = await listReviews(status);
      res.json({ _version: 1, reviews, count: reviews.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to list reviews.");
    }
  });

  // POST /api/v1/reviews
  apiRoute("post", "/reviews", limiter, requireAdmin, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const review = await createReview({
        name: body.name,
        scope: body.scope,
        scopeFilter: body.scopeFilter,
        reviewers: body.reviewers,
        dueDate: body.dueDate,
        requiredApprovals: body.requiredApprovals,
        autoRevokeOnNoAction: body.autoRevokeOnNoAction,
        createdBy: reviewerId(req),
      });
      res.status(201).json({ _version: 1, ...review });
    } catch (err) {
      if (/required|must be|invalid/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to create review.");
    }
  });

  // GET /api/v1/reviews/overdue
  apiRoute("get", "/reviews/overdue", limiter, requireUser, logRequest, async (req, res) => {
    try {
      const overdue = await getOverdueReviews();
      res.json({ _version: 1, reviews: overdue, count: overdue.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to list overdue reviews.");
    }
  });

  // POST /api/v1/reviews/recurring
  apiRoute("post", "/reviews/recurring", limiter, requireAdmin, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await scheduleRecurringReview({
        name: body.name,
        scope: body.scope,
        scopeFilter: body.scopeFilter,
        reviewers: body.reviewers,
        requiredApprovals: body.requiredApprovals,
        autoRevokeOnNoAction: body.autoRevokeOnNoAction,
        frequency: body.frequency,
        createdBy: reviewerId(req),
      });
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/required|must be|invalid/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to schedule review.");
    }
  });

  // GET /api/v1/reviews/recurring
  apiRoute("get", "/reviews/recurring", limiter, requireUser, logRequest, async (req, res) => {
    try {
      const schedules = await listRecurringSchedules();
      res.json({ _version: 1, schedules, count: schedules.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to list schedules.");
    }
  });

  // GET /api/v1/reviews/:id
  apiRoute("get", "/reviews/:id", limiter, requireUser, logRequest, async (req, res) => {
    try {
      const review = await getReview(String(req.params.id));
      if (!review) return apiError(res, 404, "NOT_FOUND", "review not found");
      res.json({ _version: 1, ...review });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to load review.");
    }
  });

  // GET /api/v1/reviews/:id/items
  apiRoute("get", "/reviews/:id/items", limiter, requireUser, logRequest, async (req, res) => {
    try {
      const items = await getReviewItems(String(req.params.id));
      if (items === null) return apiError(res, 404, "NOT_FOUND", "review not found");
      res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to load review items.");
    }
  });

  // POST /api/v1/reviews/:id/items/:userId/approve
  apiRoute(
    "post",
    "/reviews/:id/items/:userId/approve",
    limiter,
    requireUser,
    logRequest,
    async (req, res) => {
      try {
        const item = await approveAccess(
          String(req.params.id),
          String(req.params.userId),
          reviewerId(req),
          req.body?.comment || null
        );
        res.json({ _version: 1, item });
      } catch (err) {
        if (/not found/i.test(err.message)) {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        if (/not authorized/i.test(err.message)) {
          return apiError(res, 403, "FORBIDDEN", err.message);
        }
        if (/cannot modify/i.test(err.message)) {
          return apiError(res, 409, "CONFLICT", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to approve.");
      }
    }
  );

  // POST /api/v1/reviews/:id/items/:userId/revoke
  apiRoute(
    "post",
    "/reviews/:id/items/:userId/revoke",
    limiter,
    requireUser,
    logRequest,
    async (req, res) => {
      try {
        const item = await revokeAccess(
          String(req.params.id),
          String(req.params.userId),
          reviewerId(req),
          req.body?.comment || null
        );
        res.json({ _version: 1, item });
      } catch (err) {
        if (/not found/i.test(err.message)) {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        if (/not authorized/i.test(err.message)) {
          return apiError(res, 403, "FORBIDDEN", err.message);
        }
        if (/cannot modify/i.test(err.message)) {
          return apiError(res, 409, "CONFLICT", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to revoke.");
      }
    }
  );

  // POST /api/v1/reviews/:id/items/:userId/change
  apiRoute(
    "post",
    "/reviews/:id/items/:userId/change",
    limiter,
    requireUser,
    logRequest,
    async (req, res) => {
      try {
        const newRole = req.body?.newRole;
        if (!newRole) {
          return apiError(res, 400, "INVALID_INPUT", "newRole is required");
        }
        const item = await requestChange(
          String(req.params.id),
          String(req.params.userId),
          newRole,
          reviewerId(req),
          req.body?.comment || null
        );
        res.json({ _version: 1, item });
      } catch (err) {
        if (/not found/i.test(err.message)) {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        if (/not authorized/i.test(err.message)) {
          return apiError(res, 403, "FORBIDDEN", err.message);
        }
        if (/cannot modify/i.test(err.message)) {
          return apiError(res, 409, "CONFLICT", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to request change.");
      }
    }
  );

  // POST /api/v1/reviews/:id/complete
  apiRoute(
    "post",
    "/reviews/:id/complete",
    limiter,
    requireAdmin,
    logRequest,
    async (req, res) => {
      try {
        const result = await completeReview(String(req.params.id), reviewerId(req));
        res.json({ _version: 1, ...result });
      } catch (err) {
        if (/not found/i.test(err.message)) {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        if (/already/i.test(err.message)) {
          return apiError(res, 409, "CONFLICT", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to complete review.");
      }
    }
  );

  // GET /api/v1/reviews/:id/report
  apiRoute("get", "/reviews/:id/report", limiter, requireUser, logRequest, async (req, res) => {
    try {
      const report = await getReviewReport(String(req.params.id));
      if (!report) return apiError(res, 404, "NOT_FOUND", "review not found");
      res.json({ _version: 1, ...report });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to generate report.");
    }
  });

  // POST /api/v1/reviews/:id/remind
  apiRoute("post", "/reviews/:id/remind", limiter, requireAdmin, logRequest, async (req, res) => {
    try {
      const result = await sendReviewReminders(String(req.params.id));
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "Failed to send reminders.");
    }
  });
}

export default mountEntitlementReviewRoutes;
