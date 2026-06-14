/**
 * Route module: freshness SLAs (Phase 68.5).
 *
 * POST   /api/v1/freshness-sla                    — defineFreshnessSla
 * POST   /api/v1/freshness-sla/:key/updates       — recordUpdate
 * GET    /api/v1/freshness-sla                    — listFreshness
 * GET    /api/v1/freshness-sla/:key               — getFreshness
 * POST   /api/v1/freshness-sla/evaluate           — evaluateAlerts
 * GET    /api/v1/freshness-sla/alerts             — listAlerts
 */
import {
  defineFreshnessSla,
  recordUpdate,
  getFreshness,
  listFreshness,
  listAlerts,
  evaluateAlerts,
} from "../lib/freshness-sla.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountFreshnessSlaRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/freshness-sla", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await defineFreshnessSla(body.corpusKey, {
        targetMs: body.targetMs,
        name: body.name,
        description: body.description,
        severity: body.severity,
        tags: body.tags,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/freshness-sla", adminAuth, logRequest, async (req, res) => {
    try {
      const list = await listFreshness();
      res.json({ slas: list });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/freshness-sla/evaluate", adminAuth, logRequest, async (req, res) => {
    try {
      const alerts = await evaluateAlerts();
      res.json({ alerts });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/freshness-sla/alerts", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.severity) filter.severity = String(req.query.severity);
      if (req.query?.corpusKey) filter.corpusKey = String(req.query.corpusKey);
      if (req.query?.status) filter.status = String(req.query.status);
      const alerts = await listAlerts(filter);
      res.json({ alerts });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/freshness-sla/:key/updates", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await recordUpdate(req.params.key, {
        at: body.at,
        actor: body.actor,
        metadata: body.metadata,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/freshness-sla/:key", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getFreshness(req.params.key);
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountFreshnessSlaRoutes;
