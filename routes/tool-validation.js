/**
 * Phase 53.5: Tool call validation + schema-guided repair routes.
 *
 * POST /api/v1/tools/validate             — validate a value against a JSON schema
 * POST /api/v1/tools/repair               — repair a value to match a JSON schema
 * POST /api/v1/tools/validate-call        — validate a tool call against its schema
 * POST /api/v1/tools/auto-repair-call     — extract JSON + repair + validate a tool call
 * POST /api/v1/tools/extract-json         — extract JSON from free-form text
 * GET  /api/v1/tools/validation/stats     — in-process validation event stats
 */
import {
  validate,
  repair,
  validateToolCall,
  autoRepairToolCall,
  extractJson,
  recordValidationEvent,
  getValidationStats,
  formatErrors,
} from "../lib/tool-validation.js";

export function mountToolValidationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();

  // POST /api/v1/tools/validate
  apiRoute("post", "/tools/validate", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema || typeof body.schema !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "schema (object) is required");
      }
      const result = validate(body.schema, body.value);
      await recordValidationEvent({
        valid: result.valid,
        errorCount: result.errors.length,
      });
      return res.json({
        _version: 1,
        valid: result.valid,
        errors: result.errors,
        formatted: formatErrors(result.errors, "text"),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "validate failed");
    }
  });

  // POST /api/v1/tools/repair
  apiRoute("post", "/tools/repair", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema || typeof body.schema !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "schema (object) is required");
      }
      const { repaired, repairs } = repair(body.schema, body.value);
      const result = validate(body.schema, repaired);
      await recordValidationEvent({
        valid: result.valid,
        errorCount: result.errors.length,
        repaired: repairs.length > 0,
      });
      return res.json({
        _version: 1,
        valid: result.valid,
        repaired,
        repairs,
        errors: result.errors,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "repair failed");
    }
  });

  // POST /api/v1/tools/validate-call
  apiRoute("post", "/tools/validate-call", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema || typeof body.schema !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "schema (object) is required");
      }
      if (!body.call || typeof body.call !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "call (object) is required");
      }
      const result = validateToolCall(body.schema, body.call);
      await recordValidationEvent({
        valid: result.valid,
        toolName: body.call?.name || body.schema?.name,
        errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "validate-call failed");
    }
  });

  // POST /api/v1/tools/auto-repair-call
  apiRoute("post", "/tools/auto-repair-call", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.schema || typeof body.schema !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "schema (object) is required");
      }
      if (!body.call || typeof body.call !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "call (object) is required");
      }
      const result = autoRepairToolCall(body.schema, body.call);
      await recordValidationEvent({
        valid: result.valid,
        toolName: body.call?.name || body.schema?.name,
        errorCount: result.errors.length,
        repaired: result.repairs.length > 0,
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "auto-repair-call failed");
    }
  });

  // POST /api/v1/tools/extract-json
  apiRoute("post", "/tools/extract-json", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.text !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "text (string) is required");
      }
      const value = extractJson(body.text);
      return res.json({ _version: 1, found: value !== null, value });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "extract-json failed");
    }
  });

  // GET /api/v1/tools/validation/stats
  apiRoute("get", "/tools/validation/stats", log, async (_req, res) => {
    try {
      const stats = await getValidationStats();
      return res.json({ _version: 1, stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "stats failed");
    }
  });
}

export default mountToolValidationRoutes;
