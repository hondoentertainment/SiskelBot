/**
 * Route module: web ingestion (Phase 68.1).
 *
 * POST   /api/v1/web-ingestion/sources              — registerSource
 * GET    /api/v1/web-ingestion/sources              — listSources
 * GET    /api/v1/web-ingestion/sources/:id          — getSource
 * DELETE /api/v1/web-ingestion/sources/:id          — deleteSource
 * POST   /api/v1/web-ingestion/sources/:id/run      — runIngestion
 * GET    /api/v1/web-ingestion/sources/:id/status   — getIngestionStatus
 * GET    /api/v1/web-ingestion/runs/:runId          — getRun
 */
import {
  registerSource,
  getSource,
  listSources,
  deleteSource,
  runIngestion,
  getIngestionStatus,
  getRun,
} from "../lib/web-ingestion.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountWebIngestionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/web-ingestion/sources", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await registerSource({
        name: body.name,
        urls: body.urls,
        schedule: body.schedule,
        freshnessTargetMs: body.freshnessTargetMs,
        description: body.description,
        tags: body.tags,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/web-ingestion/sources", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.name) filter.name = String(req.query.name);
      if (req.query?.tag) filter.tag = String(req.query.tag);
      const sources = await listSources(filter);
      res.json({ sources });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/web-ingestion/runs/:runId", adminAuth, logRequest, async (req, res) => {
    try {
      const run = await getRun(req.params.runId);
      if (!run) return apiError(res, 404, "NOT_FOUND", "run not found");
      res.json(run);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/web-ingestion/sources/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getSource(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "source not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("delete", "/web-ingestion/sources/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteSource(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "source not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/web-ingestion/sources/:id/run", adminAuth, logRequest, async (req, res) => {
    try {
      const run = await runIngestion(req.params.id);
      res.status(201).json(run);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/web-ingestion/sources/:id/status", adminAuth, logRequest, async (req, res) => {
    try {
      const status = await getIngestionStatus(req.params.id);
      res.json(status);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountWebIngestionRoutes;
