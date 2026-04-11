/**
 * Phase 58.2: Speculative decoding routes.
 *
 * POST /api/v1/speculative/sessions         -- create a session { draftLookahead? }
 * POST /api/v1/speculative/generate         -- body { sessionId, prompt, maxTokens? }
 * GET  /api/v1/speculative/acceptance-rate  -- ?sessionId=...
 * POST /api/v1/speculative/reset            -- body { sessionId? }
 */
import {
  createSpeculativeSession,
  generateSpeculative,
  getAcceptanceRate,
  resetStats,
  getSession,
} from "../lib/speculative-decoding.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "speculative-decoding error");
}

export function mountSpeculativeDecodingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  // POST /api/v1/speculative/sessions
  apiRoute("post", "/speculative/sessions", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const session = createSpeculativeSession({
        draftLookahead: Number.isFinite(body.draftLookahead) ? body.draftLookahead : undefined,
      });
      return res.status(201).json({
        _version: 1,
        session: {
          id: session.id,
          draftLookahead: session.draftLookahead,
          createdAt: session.createdAt,
        },
      });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/speculative/generate
  apiRoute("post", "/speculative/generate", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.sessionId || typeof body.sessionId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "sessionId is required");
      }
      if (!getSession(body.sessionId)) {
        return apiError(res, 404, "NOT_FOUND", "session not found");
      }
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      const maxTokens = Number.isFinite(body.maxTokens) && body.maxTokens > 0
        ? Math.floor(body.maxTokens)
        : 32;
      const result = await generateSpeculative(body.sessionId, prompt, { maxTokens });
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/speculative/acceptance-rate
  apiRoute("get", "/speculative/acceptance-rate", log, auth, scope("read"), async (req, res) => {
    try {
      const sessionId = typeof req.query?.sessionId === "string" ? req.query.sessionId : undefined;
      const rate = await getAcceptanceRate(sessionId);
      return res.json({ _version: 1, sessionId: sessionId || null, acceptanceRate: rate });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/speculative/reset (admin-only for global resets)
  apiRoute("post", "/speculative/reset", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      await resetStats(sessionId);
      return res.json({ _version: 1, reset: true, sessionId: sessionId || null });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountSpeculativeDecodingRoutes;
