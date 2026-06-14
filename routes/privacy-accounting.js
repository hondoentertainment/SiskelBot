/**
 * Route module: privacy-accounting ledger CRUD and DP budget operations.
 *
 * GET    /api/v1/privacy/ledgers                     — list ledgers in workspace
 * POST   /api/v1/privacy/ledgers                     — create a ledger
 * GET    /api/v1/privacy/ledgers/:id                 — fetch a ledger
 * DELETE /api/v1/privacy/ledgers/:id                 — delete a ledger
 * GET    /api/v1/privacy/ledgers/:id/remaining       — remaining (ε, δ) budget
 * POST   /api/v1/privacy/ledgers/:id/record          — debit the budget
 * POST   /api/v1/privacy/ledgers/:id/check           — pre-check an operation
 * POST   /api/v1/privacy/ledgers/:id/freeze          — freeze (manual/admin)
 * GET    /api/v1/privacy/ledgers/:id/export          — JSON/CSV audit export
 * POST   /api/v1/privacy/compose                     — compose (ε, δ) releases
 * POST   /api/v1/privacy/rdp/dpsgd                   — sub-sampled Gaussian RDP accountant
 * POST   /api/v1/privacy/rdp/to-dp                   — RDP → (ε, δ)-DP conversion
 */

import {
  createPrivacyLedger,
  listPrivacyLedgers,
  getPrivacyLedger,
  deletePrivacyLedger,
  recordPrivacyLoss,
  getRemainingBudget,
  canAffordOperation,
  freezeLedger,
  composePrivacyLoss,
  subsampledGaussian,
  convertRDPtoDP,
  exportLedger,
} from "../lib/privacy-accounting.js";

export function mountPrivacyAccountingRoutes(app, deps) {
  const { apiRoute, apiError } = deps;

  const wsOf = (req) =>
    String(req.body?.workspace || req.query?.workspace || "default");

  // GET /api/v1/privacy/ledgers
  apiRoute("get", "/privacy/ledgers", async (req, res) => {
    try {
      const ledgers = listPrivacyLedgers(wsOf(req));
      res.json({ _version: 1, ledgers });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/privacy/ledgers
  apiRoute("post", "/privacy/ledgers", async (req, res) => {
    try {
      const { epsilon, delta, name, description, id } = req.body || {};
      if (typeof epsilon !== "number" || typeof delta !== "number") {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "epsilon and delta (numbers) are required",
        );
      }
      const ledger = createPrivacyLedger({
        epsilon,
        delta,
        name,
        description,
        id,
        workspaceId: wsOf(req),
      });
      res.status(201).json({ _version: 1, ledger });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // GET /api/v1/privacy/ledgers/:id
  apiRoute("get", "/privacy/ledgers/:id", async (req, res) => {
    try {
      const ledger = getPrivacyLedger(req.params.id, wsOf(req));
      if (!ledger) return apiError(res, 404, "NOT_FOUND", `ledger not found: ${req.params.id}`);
      res.json({ _version: 1, ledger });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/privacy/ledgers/:id
  apiRoute("delete", "/privacy/ledgers/:id", async (req, res) => {
    try {
      const ok = deletePrivacyLedger(req.params.id, wsOf(req));
      if (!ok) return apiError(res, 404, "NOT_FOUND", `ledger not found: ${req.params.id}`);
      res.json({ _version: 1, deleted: true, id: req.params.id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/privacy/ledgers/:id/remaining
  apiRoute("get", "/privacy/ledgers/:id/remaining", async (req, res) => {
    try {
      const status = getRemainingBudget(req.params.id);
      res.json({ _version: 1, ...status });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/privacy/ledgers/:id/record
  apiRoute("post", "/privacy/ledgers/:id/record", async (req, res) => {
    try {
      const { epsilon, delta, operation } = req.body || {};
      if (typeof epsilon !== "number" || typeof delta !== "number") {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "epsilon and delta (numbers) are required",
        );
      }
      const ledger = recordPrivacyLoss(req.params.id, epsilon, delta, operation);
      res.json({ _version: 1, ledger });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/frozen|exhausted/i.test(err.message)) {
        return apiError(res, 409, "BUDGET_EXHAUSTED", err.message);
      }
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/privacy/ledgers/:id/check
  apiRoute("post", "/privacy/ledgers/:id/check", async (req, res) => {
    try {
      const { epsilon, delta } = req.body || {};
      if (typeof epsilon !== "number" || typeof delta !== "number") {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "epsilon and delta (numbers) are required",
        );
      }
      const check = canAffordOperation(req.params.id, epsilon, delta);
      res.json({ _version: 1, ...check });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/privacy/ledgers/:id/freeze
  apiRoute("post", "/privacy/ledgers/:id/freeze", async (req, res) => {
    try {
      const { reason } = req.body || {};
      const ledger = freezeLedger(req.params.id, reason);
      res.json({ _version: 1, ledger });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/privacy/ledgers/:id/export?format=json|csv
  apiRoute("get", "/privacy/ledgers/:id/export", async (req, res) => {
    try {
      const format = String(req.query?.format || "json").toLowerCase();
      const { contentType, body } = exportLedger(req.params.id, format);
      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="privacy-ledger-${req.params.id}.${format}"`,
      );
      res.send(body);
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/privacy/compose
  apiRoute("post", "/privacy/compose", async (req, res) => {
    try {
      const { epsilons, deltas, method, deltaPrime } = req.body || {};
      if (!Array.isArray(epsilons) || !Array.isArray(deltas)) {
        return apiError(res, 400, "INVALID_INPUT", "epsilons and deltas must be arrays");
      }
      const out = composePrivacyLoss(epsilons, deltas, method || "basic", {
        deltaPrime: typeof deltaPrime === "number" ? deltaPrime : undefined,
      });
      res.json({ _version: 1, ...out, method: method || "basic" });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/privacy/rdp/dpsgd
  apiRoute("post", "/privacy/rdp/dpsgd", async (req, res) => {
    try {
      const { sigma, samplingRate, iterations, orders } = req.body || {};
      if (typeof sigma !== "number" || typeof samplingRate !== "number" || typeof iterations !== "number") {
        return apiError(
          res,
          400,
          "INVALID_INPUT",
          "sigma, samplingRate, and iterations (numbers) are required",
        );
      }
      const rdp = subsampledGaussian(sigma, samplingRate, iterations, orders);
      res.json({ _version: 1, ...rdp });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // POST /api/v1/privacy/rdp/to-dp
  apiRoute("post", "/privacy/rdp/to-dp", async (req, res) => {
    try {
      const { orders, rdp, delta } = req.body || {};
      if (typeof delta !== "number") {
        return apiError(res, 400, "INVALID_INPUT", "delta (number) is required");
      }
      const out = convertRDPtoDP({ orders, rdp }, delta);
      res.json({ _version: 1, ...out });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });
}

export default mountPrivacyAccountingRoutes;
