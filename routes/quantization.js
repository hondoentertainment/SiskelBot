/**
 * Phase 58.5: Quantization routes.
 *
 * POST /api/v1/quantization/variants            -- body { variantId, modelId, precision, ... }
 * GET  /api/v1/quantization/variants            -- ?modelId=&status=
 * POST /api/v1/quantization/variants/:id/score  -- body { score, meta? }
 * GET  /api/v1/quantization/variants/:id/gate   -- check promotion eligibility
 * POST /api/v1/quantization/variants/:id/promote
 */
import {
  registerVariant,
  listVariants,
  recordQualityScore,
  canPromote,
  promoteVariant,
} from "../lib/quantization.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "quantization error");
}

export function mountQuantizationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/quantization/variants (admin)
  apiRoute("post", "/quantization/variants", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const v = await registerVariant({
        variantId: body.variantId,
        modelId: body.modelId,
        precision: body.precision,
        qualityFloor: body.qualityFloor,
        maxScoreWindow: body.maxScoreWindow,
        notes: body.notes,
      });
      return res.status(201).json({ _version: 1, variant: v });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/quantization/variants
  apiRoute("get", "/quantization/variants", log, auth, scope("read"), async (req, res) => {
    try {
      const opts = {};
      if (typeof req.query?.modelId === "string") opts.modelId = req.query.modelId;
      if (typeof req.query?.status === "string") opts.status = req.query.status;
      const variants = await listVariants(opts);
      return res.json({ _version: 1, variants, count: variants.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/quantization/variants/:id/score
  apiRoute("post", "/quantization/variants/:id/score", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Number.isFinite(body.score)) {
        return apiError(res, 400, "INVALID_INPUT", "score is required");
      }
      const v = await recordQualityScore(req.params.id, Number(body.score), body.meta);
      return res.status(201).json({ _version: 1, variant: v });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/quantization/variants/:id/gate
  apiRoute("get", "/quantization/variants/:id/gate", log, auth, scope("read"), async (req, res) => {
    try {
      const minScores = Number.isFinite(Number(req.query?.minScores))
        ? Number(req.query.minScores)
        : undefined;
      const gate = await canPromote(req.params.id, { minScores });
      return res.json({ _version: 1, gate });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/quantization/variants/:id/promote (admin)
  apiRoute("post", "/quantization/variants/:id/promote", log, admin, async (req, res) => {
    try {
      const v = await promoteVariant(req.params.id);
      return res.json({ _version: 1, variant: v });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountQuantizationRoutes;
