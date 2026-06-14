/**
 * Route module: model approval workflows (Phase 65.1).
 *
 * POST   /api/v1/model-approvals                        — submitForApproval
 * GET    /api/v1/model-approvals                        — listApprovals
 * GET    /api/v1/model-approvals/:id                    — getApproval
 * POST   /api/v1/model-approvals/:id/review-start       — startReview
 * POST   /api/v1/model-approvals/:id/review             — reviewApproval
 * POST   /api/v1/model-approvals/:id/deploy             — markDeployed
 * POST   /api/v1/model-approvals/:id/retire             — retireApproval
 * POST   /api/v1/model-approvals/:id/reviewers          — assignReviewers
 *
 * All routes require admin auth.
 */
import {
  submitForApproval,
  getApproval,
  listApprovals,
  startReview,
  reviewApproval,
  markDeployed,
  retireApproval,
  assignReviewers,
} from "../lib/model-approval.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (err?.code === "INVALID_STATE") return { status: 409, code: "INVALID_STATE" };
  if (err?.code === "FORBIDDEN") return { status: 403, code: "FORBIDDEN" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountModelApprovalRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/model-approvals", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await submitForApproval({
        modelId: body.modelId,
        modelVersion: body.modelVersion,
        submittedBy: body.submittedBy,
        riskLevel: body.riskLevel,
        description: body.description,
        reviewers: body.reviewers,
        metadata: body.metadata,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/model-approvals", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.state) filter.state = String(req.query.state);
      if (req.query?.modelId) filter.modelId = String(req.query.modelId);
      if (req.query?.reviewer) filter.reviewer = String(req.query.reviewer);
      const approvals = await listApprovals(filter);
      res.json({ approvals });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/model-approvals/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getApproval(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "approval not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/model-approvals/:id/review-start", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await startReview(req.params.id, req.body?.actor);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/model-approvals/:id/review", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await reviewApproval(req.params.id, {
        reviewer: body.reviewer,
        decision: body.decision,
        reason: body.reason,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/model-approvals/:id/deploy", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await markDeployed(req.params.id, req.body?.actor);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/model-approvals/:id/retire", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await retireApproval(req.params.id, req.body?.actor, req.body?.reason);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/model-approvals/:id/reviewers", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await assignReviewers(req.params.id, body.reviewers, body.actor);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountModelApprovalRoutes;
