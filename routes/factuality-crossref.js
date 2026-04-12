/**
 * Route module: factuality cross-reference (Phase 67.3).
 *
 * POST   /api/v1/factuality/sources         — configureSources (batch)
 * GET    /api/v1/factuality/sources         — listSources
 * GET    /api/v1/factuality/sources/:id     — getSource
 * DELETE /api/v1/factuality/sources/:id     — deleteSource
 * POST   /api/v1/factuality/verify          — verifyClaim
 */
import {
  configureSources,
  listSources,
  getSource,
  deleteSource,
  verifyClaim,
} from "../lib/factuality-crossref.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountFactualityCrossrefRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/factuality/sources", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const sources = Array.isArray(body.sources) ? body.sources : [body];
      const rec = await configureSources(sources);
      res.status(201).json({ sources: rec });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/factuality/sources", adminAuth, logRequest, async (req, res) => {
    try {
      const sources = await listSources();
      res.json({ sources });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/factuality/sources/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getSource(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "source not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("delete", "/factuality/sources/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteSource(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "source not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/factuality/verify", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await verifyClaim({
        claim: body.claim,
        sourceIds: body.sourceIds,
        requiredPatterns: body.requiredPatterns,
      });
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountFactualityCrossrefRoutes;
