/**
 * Phase 67.2: Copyright detection routes.
 *
 * POST   /api/v1/copyright/corpus                    -- { corpusId, title, text, ngram?, metadata? }
 * GET    /api/v1/copyright/corpus                    -- list corpora
 * DELETE /api/v1/copyright/corpus/:corpusId          -- remove whole corpus
 * DELETE /api/v1/copyright/corpus/:corpusId/:entryId -- remove one entry
 * POST   /api/v1/copyright/check                     -- { text, corpusId?, threshold?, ngram?, persist? }
 * GET    /api/v1/copyright/matches                   -- list historical matches
 */
import {
  addCorpus,
  checkSimilarity,
  listCorpora,
  getMatches,
  removeCorpus,
} from "../lib/copyright-detection.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "copyright-detection error");
}

export function mountCopyrightDetectionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/copyright/corpus", log, admin, async (req, res) => {
    try {
      const rec = await addCorpus(req.body || {});
      return res.status(201).json({ _version: 1, entry: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/copyright/corpus", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listCorpora();
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/copyright/corpus/:corpusId", log, admin, async (req, res) => {
    try {
      const ok = await removeCorpus({ corpusId: req.params.corpusId });
      if (!ok) return apiError(res, 404, "NOT_FOUND", `corpus ${req.params.corpusId} not found`);
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("delete", "/copyright/corpus/:corpusId/:entryId", log, admin, async (req, res) => {
    try {
      const ok = await removeCorpus({ corpusId: req.params.corpusId, entryId: req.params.entryId });
      if (!ok) return apiError(res, 404, "NOT_FOUND", "entry not found");
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/copyright/check", log, auth, scope("read"), async (req, res) => {
    try {
      const result = await checkSimilarity(req.body || {});
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/copyright/matches", log, admin, async (req, res) => {
    try {
      const limit = Number(req.query.limit);
      const items = await getMatches({ limit: Number.isFinite(limit) ? limit : undefined });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountCopyrightDetectionRoutes;
