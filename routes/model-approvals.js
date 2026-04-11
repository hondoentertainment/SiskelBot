/**
 * Phase 65.1: Model approval workflow routes.
 *
 * POST   /api/v1/model-approvals            -- submit { modelName, version, submittedBy, riskLevel?, justification? }
 * GET    /api/v1/model-approvals            -- list pending or historical with filters
 * GET    /api/v1/model-approvals/stats      -- aggregate counts
 * GET    /api/v1/model-approvals/:id        -- fetch a single approval
 * POST   /api/v1/model-approvals/:id/approve -- { reviewer, notes? }
 * POST   /api/v1/model-approvals/:id/reject  -- { reviewer, notes? }
 * POST   /api/v1/model-approvals/:id/withdraw -- { actor, notes? }
 */
import {
  submitForApproval,
  approveModel,
  rejectModel,
  withdrawApproval,
  listPending,
  getApprovalHistory,
  getApproval,
  getApprovalStats,
} from "../lib/model-approvals.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "model-approvals error");
}

export function mountModelApprovalsRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/model-approvals", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await submitForApproval(body);
      return res.status(201).json({ _version: 1, approval: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/model-approvals", log, auth, scope("read"), async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : "";
      const modelName = typeof req.query.modelName === "string" ? req.query.modelName : undefined;
      const riskLevel = typeof req.query.riskLevel === "string" ? req.query.riskLevel : undefined;
      const limit = Number(req.query.limit);
      if (status === "pending" || !status) {
        const items = await listPending({ modelName, riskLevel });
        return res.json({ _version: 1, items, count: items.length });
      }
      const items = await getApprovalHistory({
        modelName,
        status,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/model-approvals/stats", log, auth, scope("read"), async (_req, res) => {
    try {
      const stats = await getApprovalStats();
      return res.json({ _version: 1, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/model-approvals/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const rec = await getApproval(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", `approval ${req.params.id} not found`);
      return res.json({ _version: 1, approval: rec });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/model-approvals/:id/approve", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.reviewer) return apiError(res, 400, "INVALID_INPUT", "reviewer is required");
      const rec = await approveModel(req.params.id, body);
      return res.json({ _version: 1, approval: rec });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not found") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/model-approvals/:id/reject", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.reviewer) return apiError(res, 400, "INVALID_INPUT", "reviewer is required");
      const rec = await rejectModel(req.params.id, body);
      return res.json({ _version: 1, approval: rec });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not found") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/model-approvals/:id/withdraw", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await withdrawApproval(req.params.id, body);
      return res.json({ _version: 1, approval: rec });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not found") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });
}

export default mountModelApprovalsRoutes;
