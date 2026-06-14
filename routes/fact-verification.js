/**
 * Route module: fact verification (Phase 68.3).
 *
 * POST   /api/v1/fact-verification          — verifyFact
 * GET    /api/v1/fact-verification          — listVerifications
 * GET    /api/v1/fact-verification/report   — getFactReport
 * GET    /api/v1/fact-verification/:id      — getVerification
 */
import {
  verifyFact,
  listVerifications,
  getVerification,
  getFactReport,
} from "../lib/fact-verification.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountFactVerificationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/fact-verification", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await verifyFact({
        claim: body.claim,
        agentRunId: body.agentRunId,
        messageId: body.messageId,
        modelId: body.modelId,
        sourceIds: body.sourceIds,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/fact-verification", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.agentRunId) filter.agentRunId = String(req.query.agentRunId);
      if (req.query?.messageId) filter.messageId = String(req.query.messageId);
      if (req.query?.modelId) filter.modelId = String(req.query.modelId);
      if (req.query?.verdict) filter.verdict = String(req.query.verdict);
      const verifications = await listVerifications(filter);
      res.json({ verifications });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/fact-verification/report", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.agentRunId) filter.agentRunId = String(req.query.agentRunId);
      if (req.query?.modelId) filter.modelId = String(req.query.modelId);
      if (req.query?.verdict) filter.verdict = String(req.query.verdict);
      const report = await getFactReport(filter);
      res.json(report);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/fact-verification/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getVerification(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "verification not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountFactVerificationRoutes;
