/**
 * Phase 71.3: Revenue share routes.
 *
 * POST  /api/v1/revenue-share/authors
 * GET   /api/v1/revenue-share/authors
 * GET   /api/v1/revenue-share/authors/:id
 * PUT   /api/v1/revenue-share/authors/:id/rate
 * POST  /api/v1/revenue-share/usage
 * POST  /api/v1/revenue-share/authors/:id/compute-payout
 * POST  /api/v1/revenue-share/authors/:id/payouts
 * GET   /api/v1/revenue-share/authors/:id/payouts
 */
import {
  registerAuthor,
  listAuthors,
  getAuthor,
  setShareRate,
  recordUsage,
  computePayout,
  recordPayout,
  listPayouts,
  AUTHOR_USAGE_TYPES,
} from "../lib/revenue-share.js";

export function mountRevenueShareRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/revenue-share/authors", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.authorId) return apiError(res, 400, "INVALID_INPUT", "authorId is required");
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!body.payoutMethod) return apiError(res, 400, "INVALID_INPUT", "payoutMethod is required");
      const author = await registerAuthor(body);
      res.status(201).json(author);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/revenue-share/authors", adminAuth, logRequest, async (req, res) => {
    try {
      const authors = await listAuthors();
      res.json({ authors });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/revenue-share/authors/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const a = await getAuthor(req.params?.id);
      if (!a) return apiError(res, 404, "NOT_FOUND", "author not found");
      res.json(a);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/revenue-share/authors/:id/rate", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const updated = await setShareRate({ authorId: req.params?.id, rate: body.rate });
      res.json(updated);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      if (/rate/i.test(err.message)) return apiError(res, 400, "INVALID_INPUT", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/revenue-share/usage", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!AUTHOR_USAGE_TYPES.includes(body.type)) {
        return apiError(res, 400, "INVALID_INPUT", `type must be one of ${AUTHOR_USAGE_TYPES.join(", ")}`);
      }
      const record = await recordUsage(body);
      res.status(201).json(record);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/revenue-share/authors/:id/compute-payout", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await computePayout({ authorId: req.params?.id, period: body.period });
      res.json(result);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/revenue-share/authors/:id/payouts", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const record = await recordPayout({
        authorId: req.params?.id,
        period: body.period,
        amount: body.amount,
        reference: body.reference,
      });
      res.status(201).json(record);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/revenue-share/authors/:id/payouts", adminAuth, logRequest, async (req, res) => {
    try {
      const payouts = await listPayouts(req.params?.id);
      res.json({ authorId: req.params?.id, payouts });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountRevenueShareRoutes;
