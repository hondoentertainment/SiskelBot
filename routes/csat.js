/**
 * Phase 62.5: CSAT routes.
 */
import {
  recordFeedback,
  getCsatScore,
  getTrend,
  listFeedback,
  exportCsv,
} from "../lib/csat.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "csat error");
}

export function mountCsatRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/support/csat/feedback", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await recordFeedback(req.body || {});
      return res.status(201).json({ _version: 1, feedback: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/support/csat/score", log, auth, scope("read"), async (req, res) => {
    try {
      const opts = pickOpts(req.query);
      const score = await getCsatScore(opts);
      return res.json({ _version: 1, ...score });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/support/csat/trend", log, auth, scope("read"), async (req, res) => {
    try {
      const opts = pickOpts(req.query);
      opts.bucket = req.query.bucket === "weekly" ? "weekly" : "daily";
      const trend = await getTrend(opts);
      return res.json({ _version: 1, bucket: opts.bucket, trend });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/support/csat/feedback", log, auth, scope("read"), async (req, res) => {
    try {
      const opts = pickOpts(req.query);
      opts.limit = Number(req.query.limit) || 100;
      opts.offset = Number(req.query.offset) || 0;
      const out = await listFeedback(opts);
      return res.json({ _version: 1, ...out });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/support/csat/export.csv", log, auth, scope("read"), async (req, res) => {
    try {
      const csv = await exportCsv(pickOpts(req.query));
      res.setHeader("Content-Type", "text/csv");
      return res.send(csv);
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

function pickOpts(q = {}) {
  const opts = {};
  if (q.agentId) opts.agentId = String(q.agentId);
  if (q.ticketId) opts.ticketId = String(q.ticketId);
  if (q.customerId) opts.customerId = String(q.customerId);
  if (q.from) opts.from = String(q.from);
  if (q.to) opts.to = String(q.to);
  return opts;
}

export default mountCsatRoutes;
