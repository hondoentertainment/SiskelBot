/**
 * Phase 65.3: Budget allocation routes.
 *
 * POST   /api/v1/budget/cost-centers                   -- create cost center
 * GET    /api/v1/budget/cost-centers                   -- list cost centers
 * GET    /api/v1/budget/cost-centers/:id               -- get a cost center
 * POST   /api/v1/budget/allocations                    -- allocate budget
 * GET    /api/v1/budget/allocations                    -- list allocations (?costCenterId)
 * POST   /api/v1/budget/spend                          -- record a spend event
 * GET    /api/v1/budget/spend                          -- list spend (?costCenterId&limit)
 * GET    /api/v1/budget/cost-centers/:id/utilization   -- compute utilization
 */
import {
  createCostCenter,
  allocateBudget,
  recordSpend,
  getUtilization,
  listCostCenters,
  getCostCenter,
  listAllocations,
  listSpend,
} from "../lib/budget-allocation.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "budget-allocation error");
}

function classifyError(err) {
  const msg = err?.message || "";
  if (msg.includes("not found")) return 404;
  if (msg.includes("already exists") || msg.includes("required") || msg.includes("invalid") || msg.includes("must")) return 400;
  return 500;
}

export function mountBudgetAllocationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/budget/cost-centers", log, admin, async (req, res) => {
    try {
      const cc = await createCostCenter(req.body || {});
      return res.status(201).json({ _version: 1, costCenter: cc });
    } catch (err) {
      return sendError(apiError, res, err, classifyError(err));
    }
  });

  apiRoute("get", "/budget/cost-centers", log, auth, scope("read"), async (req, res) => {
    try {
      const department = typeof req.query.department === "string" ? req.query.department : undefined;
      const items = await listCostCenters({ department });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/budget/cost-centers/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const cc = await getCostCenter(req.params.id);
      if (!cc) return apiError(res, 404, "NOT_FOUND", `cost center ${req.params.id} not found`);
      return res.json({ _version: 1, costCenter: cc });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/budget/cost-centers/:id/utilization", log, auth, scope("read"), async (req, res) => {
    try {
      const opts = {
        periodStart: typeof req.query.periodStart === "string" ? req.query.periodStart : undefined,
        periodEnd: typeof req.query.periodEnd === "string" ? req.query.periodEnd : undefined,
      };
      const util = await getUtilization(req.params.id, opts);
      return res.json({ _version: 1, utilization: util });
    } catch (err) {
      return sendError(apiError, res, err, classifyError(err));
    }
  });

  apiRoute("post", "/budget/allocations", log, admin, async (req, res) => {
    try {
      const alloc = await allocateBudget(req.body || {});
      return res.status(201).json({ _version: 1, allocation: alloc });
    } catch (err) {
      return sendError(apiError, res, err, classifyError(err));
    }
  });

  apiRoute("get", "/budget/allocations", log, auth, scope("read"), async (req, res) => {
    try {
      const costCenterId = typeof req.query.costCenterId === "string" ? req.query.costCenterId : undefined;
      const items = await listAllocations({ costCenterId });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/budget/spend", log, auth, scope("write"), async (req, res) => {
    try {
      const ev = await recordSpend(req.body || {});
      return res.status(201).json({ _version: 1, event: ev });
    } catch (err) {
      return sendError(apiError, res, err, classifyError(err));
    }
  });

  apiRoute("get", "/budget/spend", log, auth, scope("read"), async (req, res) => {
    try {
      const costCenterId = typeof req.query.costCenterId === "string" ? req.query.costCenterId : undefined;
      const limit = Number(req.query.limit);
      const items = await listSpend({ costCenterId, limit: Number.isFinite(limit) ? limit : undefined });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountBudgetAllocationRoutes;
