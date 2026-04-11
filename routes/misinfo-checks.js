/**
 * Phase 67.3: Misinformation checks routes.
 *
 * POST   /api/v1/misinfo/sources         -- { name, url?, credibility?, category? }
 * GET    /api/v1/misinfo/sources         -- list (with ?category&minCredibility)
 * GET    /api/v1/misinfo/sources/ranked  -- ranked
 * POST   /api/v1/misinfo/claims          -- { statement, verdict?, sources? }
 * GET    /api/v1/misinfo/claims          -- list (?verdict&limit)
 * POST   /api/v1/misinfo/check           -- { statement, minOverlap? }
 */
import {
  addClaim,
  checkClaim,
  listClaims,
  addSource,
  rankSourceCredibility,
  listSources,
} from "../lib/misinfo-checks.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "misinfo-checks error");
}

export function mountMisinfoChecksRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/misinfo/sources", log, admin, async (req, res) => {
    try {
      const rec = await addSource(req.body || {});
      return res.status(201).json({ _version: 1, source: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/misinfo/sources", log, auth, scope("read"), async (req, res) => {
    try {
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      const minCredibility = Number(req.query.minCredibility);
      const items = await listSources({
        category,
        minCredibility: Number.isFinite(minCredibility) ? minCredibility : undefined,
      });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/misinfo/sources/ranked", log, auth, scope("read"), async (req, res) => {
    try {
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      const items = await rankSourceCredibility({ category });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/misinfo/claims", log, admin, async (req, res) => {
    try {
      const rec = await addClaim(req.body || {});
      return res.status(201).json({ _version: 1, claim: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/misinfo/claims", log, auth, scope("read"), async (req, res) => {
    try {
      const verdict = typeof req.query.verdict === "string" ? req.query.verdict : undefined;
      const limit = Number(req.query.limit);
      const items = await listClaims({ verdict, limit: Number.isFinite(limit) ? limit : undefined });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/misinfo/check", log, auth, scope("read"), async (req, res) => {
    try {
      const result = await checkClaim(req.body || {});
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountMisinfoChecksRoutes;
