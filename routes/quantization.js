/**
 * Phase 58.5: Quantization management routes.
 *
 * Endpoints:
 *   GET    /api/v1/quantization/methods                       — static method catalog
 *   POST   /api/v1/quantization/variants                      — register a variant
 *   GET    /api/v1/quantization/variants                      — list variants
 *   GET    /api/v1/quantization/variants/:id                  — fetch variant
 *   DELETE /api/v1/quantization/variants/:id                  — remove variant
 *   POST   /api/v1/quantization/estimate                      — size/quality estimate
 *   POST   /api/v1/quantization/variants/:id/gate             — admin: set quality gate
 *   POST   /api/v1/quantization/variants/:id/benchmark        — record a benchmark result
 *   GET    /api/v1/quantization/variants/:id/benchmarks       — list benchmarks
 *   POST   /api/v1/quantization/variants/:id/promote          — admin: promote to env
 *   POST   /api/v1/quantization/variants/:id/deprecate        — admin: deprecate
 *   POST   /api/v1/quantization/recommend                     — recommend matching constraints
 *   POST   /api/v1/quantization/compare                       — compare variants
 */
import {
  QUANT_METHODS,
  registerVariant,
  getVariant,
  listVariants,
  removeVariant,
  estimateSize,
  estimateMemoryUsage,
  estimateQualityLoss,
  setQualityGate,
  getQualityGate,
  recordBenchmarkResult,
  getBenchmarkHistory,
  promoteVariant,
  deprecateVariant,
  getVariantStatus,
  recommendVariant,
  compareVariants,
} from "../lib/quantization.js";

export function mountQuantizationRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
    userAuth,
    requireScope,
    storageRateLimiter,
    adminAuth,
  } = deps;

  const auth = typeof userAuth === "function" ? userAuth : (_req, _res, next) => next();
  const admin = typeof adminAuth === "function" ? adminAuth : auth;
  const scopeRead = requireScope ? requireScope("read") : (_req, _res, next) => next();
  const scopeWrite = requireScope ? requireScope("write") : (_req, _res, next) => next();
  const limiter = storageRateLimiter || ((_req, _res, next) => next());
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();

  const BASE = "/quantization";

  // GET /quantization/methods
  apiRoute("get", `${BASE}/methods`, limiter, auth, scopeRead, log, (_req, res) => {
    res.json({ _version: 1, methods: QUANT_METHODS });
  });

  // POST /quantization/variants
  apiRoute("post", `${BASE}/variants`, limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await registerVariant({
        baseModel: body.baseModel,
        method: body.method,
        sizeMb: body.sizeMb,
        url: body.url,
        metadata: body.metadata,
      });
      res.status(201).json({ _version: 1, ...result });
    } catch (err) {
      if (/required|must be one of/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /quantization/variants
  apiRoute("get", `${BASE}/variants`, limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const filter = {
        baseModel: req.query?.baseModel ? String(req.query.baseModel) : undefined,
        method: req.query?.method ? String(req.query.method) : undefined,
        status: req.query?.status ? String(req.query.status) : undefined,
      };
      const variants = await listVariants(filter);
      res.json({ _version: 1, variants });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /quantization/variants/:id
  apiRoute("get", `${BASE}/variants/:id`, limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const variant = await getVariant(req.params.id);
      if (!variant) return apiError(res, 404, "NOT_FOUND", "variant not found");
      const status = await getVariantStatus(req.params.id);
      res.json({ _version: 1, variant, ...status });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /quantization/variants/:id
  apiRoute("delete", `${BASE}/variants/:id`, limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const result = await removeVariant(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", result.error);
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /quantization/estimate
  apiRoute("post", `${BASE}/estimate`, limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const body = req.body || {};
      const params = Number(body.params);
      const method = body.method;
      const batchSize = body.batchSize != null ? Number(body.batchSize) : 1;
      const calibrationQuality = body.calibrationQuality != null ? Number(body.calibrationQuality) : null;
      if (!Number.isFinite(params) || params <= 0) {
        return apiError(res, 400, "INVALID_INPUT", "params (billions) must be a positive number");
      }
      if (!method) {
        return apiError(res, 400, "INVALID_INPUT", "method is required");
      }
      if (!QUANT_METHODS[method]) {
        return apiError(res, 400, "INVALID_INPUT", `unknown method: ${method}`);
      }
      const sizeMb = estimateSize(params, method);
      const memoryMb = estimateMemoryUsage(params, method, batchSize);
      const qualityLoss = estimateQualityLoss(method, calibrationQuality);
      res.json({
        _version: 1,
        method,
        params,
        sizeMb,
        memoryMb,
        qualityLoss,
        quality: Math.round((1 - qualityLoss) * 10000) / 10000,
      });
    } catch (err) {
      if (/required|unknown|positive number/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /quantization/variants/:id/gate — admin set
  apiRoute("post", `${BASE}/variants/:id/gate`, limiter, admin, scopeWrite, log, async (req, res) => {
    try {
      const minScore = Number(req.body?.minScore);
      if (!Number.isFinite(minScore)) {
        return apiError(res, 400, "INVALID_INPUT", "minScore must be a number");
      }
      const result = await setQualityGate(req.params.id, minScore);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required|must be/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /quantization/variants/:id/benchmark
  apiRoute("post", `${BASE}/variants/:id/benchmark`, limiter, auth, scopeWrite, log, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body !== "object" || body === null) {
        return apiError(res, 400, "INVALID_INPUT", "benchmark body is required");
      }
      const variant = await getVariant(req.params.id);
      if (!variant) return apiError(res, 404, "NOT_FOUND", "variant not found");
      // Accept caller-provided result object directly.
      const result = {
        name: typeof body.name === "string" ? body.name : "unnamed",
        avgScore: Number(body.avgScore) || 0,
        avgLatencyMs: Number(body.avgLatencyMs) || 0,
        items: Number(body.items) || 0,
        errors: Number(body.errors) || 0,
        ranAt: body.ranAt || new Date().toISOString(),
        notes: typeof body.notes === "string" ? body.notes : undefined,
      };
      const persist = await recordBenchmarkResult(req.params.id, result);
      const gate = await getQualityGate(req.params.id);
      const gatePass = gate ? result.avgScore >= gate.minScore : true;
      res.status(201).json({ _version: 1, ...persist, result, gate, gatePass });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required|must be/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /quantization/variants/:id/benchmarks
  apiRoute("get", `${BASE}/variants/:id/benchmarks`, limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const variant = await getVariant(req.params.id);
      if (!variant) return apiError(res, 404, "NOT_FOUND", "variant not found");
      const benchmarks = await getBenchmarkHistory(req.params.id);
      res.json({ _version: 1, id: req.params.id, benchmarks });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /quantization/variants/:id/promote — admin
  apiRoute("post", `${BASE}/variants/:id/promote`, limiter, admin, scopeWrite, log, async (req, res) => {
    try {
      const environment = req.body?.environment || "prod";
      const result = await promoteVariant(req.params.id, environment);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/must be one of|required|cannot promote/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /quantization/variants/:id/deprecate — admin
  apiRoute("post", `${BASE}/variants/:id/deprecate`, limiter, admin, scopeWrite, log, async (req, res) => {
    try {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "deprecated";
      const result = await deprecateVariant(req.params.id, reason);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /quantization/recommend
  apiRoute("post", `${BASE}/recommend`, limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const constraints = req.body?.constraints || req.body || {};
      const filter = {
        baseModel: constraints.baseModel,
        method: constraints.method,
      };
      const variants = await listVariants(filter);
      const recommendations = recommendVariant({
        variants,
        targetSizeMb: constraints.targetSizeMb,
        minQuality: constraints.minQuality,
        preferredMethods: constraints.preferredMethods,
      });
      res.json({ _version: 1, recommendations });
    } catch (err) {
      if (/requires constraints/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /quantization/compare
  apiRoute("post", `${BASE}/compare`, limiter, auth, scopeRead, log, async (req, res) => {
    try {
      const variantIds = req.body?.variantIds;
      if (!Array.isArray(variantIds) || variantIds.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "variantIds must be a non-empty array");
      }
      const rows = await compareVariants(variantIds);
      res.json({ _version: 1, rows });
    } catch (err) {
      if (/non-empty array/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountQuantizationRoutes;
