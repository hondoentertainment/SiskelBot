/**
 * Phase 48.4: Crypto payment routes.
 *
 * POST   /api/v1/payments/crypto/invoice             — create an invoice
 * GET    /api/v1/payments/crypto/invoice/:id         — fetch an invoice
 * GET    /api/v1/payments/crypto/invoices            — list invoices (filter by user/workspace/status/currency)
 * POST   /api/v1/payments/crypto/invoice/:id/verify  — run the verification checker
 * POST   /api/v1/payments/crypto/invoice/:id/record  — record a payment (admin/webhook)
 * POST   /api/v1/payments/crypto/invoice/:id/refund  — refund a paid invoice (admin)
 * GET    /api/v1/payments/crypto/currencies          — list supported currencies
 */
import {
  createInvoice,
  getInvoice,
  listInvoices,
  verifyPayment,
  recordPayment,
  refundPayment,
  getUserPaymentHistory,
  listSupportedCurrencies,
  SUPPORTED_CURRENCIES,
} from "../lib/crypto-payments.js";

function mapErrorStatus(message) {
  const m = String(message || "");
  if (/not found/i.test(m)) return 404;
  if (/required|must be|unsupported|only paid|has been|has expired/i.test(m)) return 400;
  return 500;
}

function sendError(apiError, res, err) {
  const status = mapErrorStatus(err?.message);
  const code = status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "crypto-payments error");
}

export function mountCryptoPaymentRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = () => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  const userIdOf = (req) =>
    (req.user && (req.user.id || req.user.userId || req.user.sub)) ||
    req.body?.userId ||
    req.query?.userId ||
    "anonymous";

  // GET /api/v1/payments/crypto/currencies
  apiRoute("get", "/payments/crypto/currencies", log, async (_req, res) => {
    try {
      return res.json({ _version: 1, currencies: listSupportedCurrencies() });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/payments/crypto/invoice
  apiRoute("post", "/payments/crypto/invoice", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const userId = userIdOf(req);
      const invoice = await createInvoice({
        userId,
        workspaceId: body.workspaceId || body.workspace,
        amount: body.amount,
        currency: body.currency,
        description: body.description,
        expiresInMs: body.expiresInMs,
        metadata: body.metadata,
      });
      return res.status(201).json({ _version: 1, invoice });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/payments/crypto/invoice/:id
  apiRoute("get", "/payments/crypto/invoice/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const invoice = await getInvoice(req.params.id);
      if (!invoice) {
        return apiError(res, 404, "NOT_FOUND", `invoice ${req.params.id} not found`);
      }
      return res.json({ _version: 1, invoice });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/payments/crypto/invoices
  apiRoute("get", "/payments/crypto/invoices", log, auth, scope("read"), async (req, res) => {
    try {
      const filter = {
        userId: req.query?.userId || userIdOf(req),
        workspaceId: req.query?.workspaceId || req.query?.workspace,
        status: req.query?.status,
        currency: req.query?.currency,
      };
      // Remove blank filters so listInvoices does not filter on them.
      for (const k of Object.keys(filter)) {
        if (filter[k] === undefined || filter[k] === null || filter[k] === "") delete filter[k];
      }
      const invoices = req.query?.all === "1" || req.query?.all === "true"
        ? await listInvoices({})
        : filter.userId
          ? await getUserPaymentHistory(filter.userId)
          : await listInvoices(filter);

      // If other filters are provided alongside user-based retrieval, apply them here.
      let result = invoices;
      if (filter.workspaceId) result = result.filter((i) => i.workspaceId === filter.workspaceId);
      if (filter.status) result = result.filter((i) => i.status === filter.status);
      if (filter.currency) result = result.filter((i) => i.currency === filter.currency);

      return res.json({ _version: 1, invoices: result, count: result.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/payments/crypto/invoice/:id/verify
  apiRoute("post", "/payments/crypto/invoice/:id/verify", log, auth, scope("write"), async (req, res) => {
    try {
      const result = await verifyPayment(req.params.id, req.body || {});
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/payments/crypto/invoice/:id/record
  apiRoute("post", "/payments/crypto/invoice/:id/record", log, auth, scope("admin"), async (req, res) => {
    try {
      const { txHash, amount, fromAddress } = req.body || {};
      if (!txHash) return apiError(res, 400, "INVALID_INPUT", "txHash is required");
      if (amount === undefined || amount === null) {
        return apiError(res, 400, "INVALID_INPUT", "amount is required");
      }
      const invoice = await recordPayment(req.params.id, txHash, Number(amount), fromAddress || null);
      return res.json({ _version: 1, invoice });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/payments/crypto/invoice/:id/refund
  apiRoute("post", "/payments/crypto/invoice/:id/refund", log, auth, scope("admin"), async (req, res) => {
    try {
      const reason = req.body?.reason;
      if (!reason) return apiError(res, 400, "INVALID_INPUT", "reason is required");
      const invoice = await refundPayment(req.params.id, reason);
      return res.json({ _version: 1, invoice });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // Expose supported currencies as a read-only constant for quick discovery.
  app.locals = app.locals || {};
  app.locals.cryptoSupportedCurrencies = SUPPORTED_CURRENCIES;
}

export default mountCryptoPaymentRoutes;
