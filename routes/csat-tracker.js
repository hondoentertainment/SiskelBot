/**
 * Phase 62.5: CSAT tracker routes.
 *
 * POST /api/v1/csat/feedback          — record feedback entry
 * GET  /api/v1/csat/feedback          — list feedback
 * GET  /api/v1/csat/report            — aggregated CSAT/NPS report
 */
import {
  recordFeedback,
  listFeedback,
  getCsatReport,
} from "../lib/csat-tracker.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required|must be/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountCsatTrackerRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /csat/feedback
  apiRoute("post", "/csat/feedback", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const entry = await recordFeedback({
        ticketId: body.ticketId,
        agentId: body.agentId,
        csat: body.csat,
        nps: body.nps,
        comment: body.comment,
        tags: body.tags,
      });
      res.status(201).json(entry);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /csat/feedback
  apiRoute("get", "/csat/feedback", adminAuth, logRequest, async (req, res) => {
    try {
      const items = await listFeedback({
        agentId: req.query?.agentId ? String(req.query.agentId) : undefined,
        ticketId: req.query?.ticketId ? String(req.query.ticketId) : undefined,
        since: req.query?.since ? String(req.query.since) : undefined,
        limit: Number(req.query?.limit) || 100,
      });
      res.json({ feedback: items });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /csat/report
  apiRoute("get", "/csat/report", adminAuth, logRequest, async (req, res) => {
    try {
      const report = await getCsatReport({
        since: req.query?.since ? String(req.query.since) : undefined,
        trendDays: Number(req.query?.trendDays) || 30,
      });
      res.json(report);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountCsatTrackerRoutes;
