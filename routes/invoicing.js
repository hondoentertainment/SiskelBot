/**
 * Phase 71.5: Invoicing routes.
 *
 * POST /api/v1/invoices
 * GET  /api/v1/invoices?workspaceId=
 * GET  /api/v1/invoices/:id
 * POST /api/v1/invoices/:id/paid
 * POST /api/v1/invoices/:id/void
 * GET  /api/v1/invoices/:id/export?format=json|text
 */
import {
  createInvoice,
  getInvoice,
  listInvoices,
  markPaid,
  voidInvoice,
  exportInvoiceJson,
  exportInvoiceText,
} from "../lib/invoicing.js";

export function mountInvoicingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/invoices", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.workspaceId) return apiError(res, 400, "INVALID_INPUT", "workspaceId is required");
      if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "lineItems must be a non-empty array");
      }
      const inv = await createInvoice(body);
      res.status(201).json(inv);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/invoices", adminAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId || "default";
      const invoices = await listInvoices(workspaceId);
      res.json({ workspaceId, invoices });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/invoices/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const inv = await getInvoice(req.params?.id);
      if (!inv) return apiError(res, 404, "NOT_FOUND", "invoice not found");
      res.json(inv);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/invoices/:id/paid", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.paymentReference) return apiError(res, 400, "INVALID_INPUT", "paymentReference is required");
      const inv = await markPaid({
        invoiceId: req.params?.id,
        paymentReference: body.paymentReference,
        paidAt: body.paidAt,
      });
      res.json(inv);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("post", "/invoices/:id/void", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.reason) return apiError(res, 400, "INVALID_INPUT", "reason is required");
      const inv = await voidInvoice({ invoiceId: req.params?.id, reason: body.reason });
      res.json(inv);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/invoices/:id/export", adminAuth, logRequest, async (req, res) => {
    try {
      const format = req.query?.format === "text" ? "text" : "json";
      if (format === "text") {
        const body = await exportInvoiceText(req.params?.id);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        return res.send(body);
      }
      const body = await exportInvoiceJson(req.params?.id);
      res.setHeader("Content-Type", "application/json");
      return res.send(body);
    } catch (err) {
      if (/not found/i.test(err.message)) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountInvoicingRoutes;
