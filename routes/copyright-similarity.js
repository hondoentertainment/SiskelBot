/**
 * Route module: copyright similarity (Phase 67.2).
 *
 * Operator-supplied corpora. No content is preloaded.
 *
 * POST   /api/v1/copyright/corpora              — indexCorpus
 * GET    /api/v1/copyright/corpora              — listCorpora
 * GET    /api/v1/copyright/corpora/:id          — getCorpus
 * DELETE /api/v1/copyright/corpora/:id          — deleteCorpus
 * POST   /api/v1/copyright/corpora/:id/search   — findSimilar
 */
import {
  indexCorpus,
  listCorpora,
  getCorpus,
  deleteCorpus,
  findSimilar,
} from "../lib/copyright-similarity.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountCopyrightSimilarityRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/copyright/corpora", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await indexCorpus({
        name: body.name,
        items: body.items,
        shingleSize: body.shingleSize,
        description: body.description,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/copyright/corpora", adminAuth, logRequest, async (req, res) => {
    try {
      const corpora = await listCorpora();
      res.json({ corpora });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/copyright/corpora/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getCorpus(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "corpus not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("delete", "/copyright/corpora/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteCorpus(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "corpus not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/copyright/corpora/:id/search", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await findSimilar(req.params.id, {
        text: body.text,
        minScore: body.minScore,
        limit: body.limit,
      });
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountCopyrightSimilarityRoutes;
