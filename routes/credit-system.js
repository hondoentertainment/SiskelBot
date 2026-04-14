/**
 * Phase 71.4: Credit system routes.
 *
 * POST /api/v1/credits/add
 * POST /api/v1/credits/consume
 * POST /api/v1/credits/refund
 * GET  /api/v1/credits/:userId/balance
 * GET  /api/v1/credits/:userId/transactions?type=&limit=&offset=
 */
import {
  addCredits,
  consumeCredits,
  refundCredits,
  getBalance,
  listTransactions,
  TRANSACTION_TYPES,
} from "../lib/credit-system.js";

export function mountCreditRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/credits/add", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.userId) return apiError(res, 400, "INVALID_INPUT", "userId is required");
      if (!body.source) return apiError(res, 400, "INVALID_INPUT", "source is required");
      const rec = await addCredits(body);
      res.status(201).json(rec);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/credits/consume", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.userId) return apiError(res, 400, "INVALID_INPUT", "userId is required");
      if (!body.reason) return apiError(res, 400, "INVALID_INPUT", "reason is required");
      const rec = await consumeCredits(body);
      res.status(201).json(rec);
    } catch (err) {
      if (/insufficient/i.test(err.message)) {
        return apiError(res, 402, "INSUFFICIENT_CREDITS", err.message);
      }
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/credits/refund", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.userId) return apiError(res, 400, "INVALID_INPUT", "userId is required");
      if (!body.transactionId) return apiError(res, 400, "INVALID_INPUT", "transactionId is required");
      const rec = await refundCredits(body);
      res.status(201).json(rec);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/credits/:userId/balance", adminAuth, logRequest, async (req, res) => {
    try {
      const b = await getBalance(req.params?.userId);
      res.json(b);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/credits/:userId/transactions", adminAuth, logRequest, async (req, res) => {
    try {
      const type = req.query?.type;
      if (type && !TRANSACTION_TYPES.includes(type)) {
        return apiError(res, 400, "INVALID_INPUT", `type must be one of ${TRANSACTION_TYPES.join(", ")}`);
      }
      const out = await listTransactions({
        userId: req.params?.userId,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
        type,
      });
      res.json(out);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountCreditRoutes;
