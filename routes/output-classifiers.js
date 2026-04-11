/**
 * Phase 51.3: Output classifier routes.
 *
 *   POST /api/v1/classify/toxicity       — body: { text }
 *   POST /api/v1/classify/pii            — body: { text }           (?redact=1 to redact)
 *   POST /api/v1/classify/bias           — body: { text }
 *   POST /api/v1/classify/hallucination  — body: { text, groundTruth? }
 *   POST /api/v1/classify/all            — unified report
 *   GET  /api/v1/classify/stats          — aggregate counts
 */
import {
  classifyToxicity,
  detectPii,
  redactPii,
  classifyBias,
  detectHallucination,
  classifyOutput,
  logClassificationEvent,
  getClassificationStats,
} from "../lib/output-classifiers.js";

function requireText(apiError, res, body) {
  if (!body || typeof body.text !== "string") {
    apiError(res, 400, "INVALID_INPUT", "text (string) is required");
    return null;
  }
  return body.text;
}

function resolveContext(req) {
  return {
    workspaceId: req.headers["x-workspace-id"] || req.query.workspace || req.body?.workspaceId || null,
    userId: req.user?.id || req.headers["x-user-id"] || null,
  };
}

export function mountOutputClassifiersRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, isAuthConfigured } = deps;

  const noop = (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : noop;
  const auth =
    typeof userAuth === "function" && typeof isAuthConfigured === "function" && isAuthConfigured()
      ? userAuth
      : noop;

  // POST /api/v1/classify/toxicity
  apiRoute("post", "/classify/toxicity", log, auth, async (req, res) => {
    try {
      const text = requireText(apiError, res, req.body);
      if (text == null) return;
      const result = classifyToxicity(text);
      const ctx = resolveContext(req);
      await logClassificationEvent({
        source: "toxicity",
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        text,
        report: { toxicity: result, pii: { found: false }, bias: { biased: false }, hallucination: { likelyHallucination: false } },
      });
      return res.json({ ok: true, result });
    } catch (err) {
      console.error("classify/toxicity error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/classify/pii
  apiRoute("post", "/classify/pii", log, auth, async (req, res) => {
    try {
      const text = requireText(apiError, res, req.body);
      if (text == null) return;
      const shouldRedact = req.query.redact === "1" || req.body?.redact === true;
      let result;
      if (shouldRedact) {
        const mode = req.body?.mode || req.query.mode || "redact";
        const placeholder = req.body?.placeholder || undefined;
        const types = Array.isArray(req.body?.types) ? req.body.types : undefined;
        const redacted = redactPii(text, { mode, placeholder, types });
        const detected = detectPii(text);
        result = {
          found: detected.found,
          types: detected.types,
          count: detected.matches.length,
          redactedText: redacted.text,
          redactedCount: redacted.redactedCount,
        };
      } else {
        const detected = detectPii(text);
        result = {
          found: detected.found,
          types: detected.types,
          count: detected.matches.length,
          matches: detected.matches,
        };
      }
      const ctx = resolveContext(req);
      await logClassificationEvent({
        source: "pii",
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        text,
        report: {
          toxicity: { toxic: false },
          pii: { found: result.found, types: result.types },
          bias: { biased: false },
          hallucination: { likelyHallucination: false },
        },
      });
      return res.json({ ok: true, result });
    } catch (err) {
      console.error("classify/pii error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/classify/bias
  apiRoute("post", "/classify/bias", log, auth, async (req, res) => {
    try {
      const text = requireText(apiError, res, req.body);
      if (text == null) return;
      const result = classifyBias(text);
      const ctx = resolveContext(req);
      await logClassificationEvent({
        source: "bias",
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        text,
        report: { toxicity: { toxic: false }, pii: { found: false }, bias: result, hallucination: { likelyHallucination: false } },
      });
      return res.json({ ok: true, result });
    } catch (err) {
      console.error("classify/bias error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/classify/hallucination
  apiRoute("post", "/classify/hallucination", log, auth, async (req, res) => {
    try {
      const text = requireText(apiError, res, req.body);
      if (text == null) return;
      const groundTruth = req.body?.groundTruth ?? null;
      const result = detectHallucination(text, groundTruth);
      const ctx = resolveContext(req);
      await logClassificationEvent({
        source: "hallucination",
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        text,
        report: { toxicity: { toxic: false }, pii: { found: false }, bias: { biased: false }, hallucination: result },
      });
      return res.json({ ok: true, result });
    } catch (err) {
      console.error("classify/hallucination error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/classify/all
  apiRoute("post", "/classify/all", log, auth, async (req, res) => {
    try {
      const text = requireText(apiError, res, req.body);
      if (text == null) return;
      const result = await classifyOutput(text, {
        groundTruth: req.body?.groundTruth ?? null,
        includeFlagged: req.body?.includeFlagged === true,
      });
      const ctx = resolveContext(req);
      await logClassificationEvent({
        source: "all",
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        text,
        report: result,
      });
      return res.json({ ok: true, result });
    } catch (err) {
      console.error("classify/all error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/classify/stats
  apiRoute("get", "/classify/stats", log, auth, async (req, res) => {
    try {
      const from = req.query.from ? Number(req.query.from) : undefined;
      const to = req.query.to ? Number(req.query.to) : undefined;
      const workspaceId = req.query.workspace || req.headers["x-workspace-id"] || undefined;
      const source = req.query.source || undefined;
      const stats = await getClassificationStats({ from, to, workspaceId, source });
      return res.json({ ok: true, stats });
    } catch (err) {
      console.error("classify/stats error:", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountOutputClassifiersRoutes;
