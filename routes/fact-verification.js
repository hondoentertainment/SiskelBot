/**
 * Phase 68.3: Fact verification routes.
 *
 * POST /api/v1/fact-verification/sources  -- add a source { name, corpus, trust? }
 * GET  /api/v1/fact-verification/sources  -- list
 * POST /api/v1/fact-verification/verify   -- body { claim }
 * GET  /api/v1/fact-verification/claims   -- list all claim verdicts
 * POST /api/v1/fact-verification/status   -- body { claim } -> current verdict
 */
import {
  addAuthoritativeSource,
  listSources,
  verifyClaim,
  getClaimStatus,
  listClaims,
} from "../lib/fact-verification.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "fact-verification error");
}

export function mountFactVerificationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/fact-verification/sources", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await addAuthoritativeSource(req.body || {});
      return res.status(201).json({ _version: 1, source: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/fact-verification/sources", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listSources();
      return res.json({ _version: 1, sources: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/fact-verification/verify", log, auth, scope("read"), async (req, res) => {
    try {
      const claim = typeof req.body?.claim === "string" ? req.body.claim : "";
      if (!claim.trim()) return apiError(res, 400, "INVALID_INPUT", "claim is required");
      const r = await verifyClaim(claim);
      return res.json({ _version: 1, result: r });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/fact-verification/claims", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listClaims();
      return res.json({ _version: 1, claims: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/fact-verification/status", log, auth, scope("read"), async (req, res) => {
    try {
      const claim = typeof req.body?.claim === "string" ? req.body.claim : "";
      if (!claim.trim()) return apiError(res, 400, "INVALID_INPUT", "claim is required");
      const r = await getClaimStatus(claim);
      if (!r) return apiError(res, 404, "NOT_FOUND", "claim not yet verified");
      return res.json({ _version: 1, status: r });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountFactVerificationRoutes;
