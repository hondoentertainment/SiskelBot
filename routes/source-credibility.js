/**
 * Phase 68.4: Source credibility routes.
 */
import {
  updateReputation,
  listSources,
  getReputation,
  exportScorecard,
  scoreSource,
} from "../lib/source-credibility.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "source-credibility error");
}

export function mountSourceCredibilityRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/source-credibility/reputation/:id", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await updateReputation(req.params.id, req.body || {});
      return res.status(201).json({ _version: 1, source: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/source-credibility/reputation/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const rec = await getReputation(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "source not found");
      return res.json({ _version: 1, source: rec });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/source-credibility/sources", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listSources();
      return res.json({ _version: 1, sources: items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/source-credibility/scorecard", log, auth, scope("read"), async (_req, res) => {
    try {
      const r = await exportScorecard();
      return res.json({ _version: 1, scorecard: r });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/source-credibility/score", log, auth, scope("read"), async (req, res) => {
    try {
      const s = scoreSource(req.body || {});
      return res.json({ _version: 1, score: s });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountSourceCredibilityRoutes;
