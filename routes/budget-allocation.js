/**
 * Route module: budget allocation (Phase 65.3).
 *
 * POST   /api/v1/budget/cost-centers                   — createCostCenter
 * GET    /api/v1/budget/cost-centers                   — listCostCenters
 * GET    /api/v1/budget/cost-centers/:id               — getCostCenter
 * POST   /api/v1/budget/cost-centers/:id/allocations   — allocateBudget
 * POST   /api/v1/budget/cost-centers/:id/charges       — recordCharge
 * GET    /api/v1/budget/cost-centers/:id/report        — getChargebackReport
 */
import {
  createCostCenter,
  getCostCenter,
  listCostCenters,
  allocateBudget,
  recordCharge,
  getChargebackReport,
} from "../lib/budget-allocation.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountBudgetAllocationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/budget/cost-centers", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await createCostCenter({
        name: body.name,
        owner: body.owner,
        department: body.department,
        tags: body.tags,
        description: body.description,
        alertThresholds: body.alertThresholds,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/budget/cost-centers", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.department) filter.department = String(req.query.department);
      if (req.query?.name) filter.name = String(req.query.name);
      const centers = await listCostCenters(filter);
      res.json({ costCenters: centers });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/budget/cost-centers/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getCostCenter(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "cost center not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/budget/cost-centers/:id/allocations", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await allocateBudget(req.params.id, {
        amountUsd: body.amountUsd,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        note: body.note,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/budget/cost-centers/:id/charges", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await recordCharge(req.params.id, {
        amountUsd: body.amountUsd,
        subject: body.subject,
        description: body.description,
        at: body.at,
        metadata: body.metadata,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/budget/cost-centers/:id/report", adminAuth, logRequest, async (req, res) => {
    try {
      const report = await getChargebackReport(req.params.id, {
        periodStart: req.query?.periodStart,
        periodEnd: req.query?.periodEnd,
      });
      res.json(report);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountBudgetAllocationRoutes;
