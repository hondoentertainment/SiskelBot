/**
 * Human feedback collection routes for agent runs.
 *
 * Provides a thumbs-up / thumbs-down + score + tags + comment capture surface
 * backed by lib/agent-feedback-store.js. Without this surface, SiskelBot only
 * has automated signals (failure categories, genealogy, swarm conflicts,
 * tool-result judge) -- no way to collect RLHF training signal or A/B test
 * improvements against real user sentiment.
 *
 * Public user routes (per-run feedback):
 *   POST /api/v1/agent/feedback                      (user-authed)
 *   GET  /api/v1/agent/feedback?runId=X              (user-authed)
 *
 * Admin routes (workspace-wide):
 *   GET    /api/v1/admin/agent-feedback?workspace=X&limit=50
 *   GET    /api/v1/admin/agent-feedback/aggregate?workspace=X&sinceTs=Y
 *   DELETE /api/v1/admin/agent-feedback?workspace=X
 *
 * Follows the deps/apiRoute/userAuth/adminAuth pattern from
 * routes/agent-sessions.js + routes/admin-agent-stats.js.
 */

import rateLimit from "express-rate-limit";
import {
  recordFeedback,
  listFeedback,
  aggregateFeedback,
  clearFeedback,
} from "../lib/agent-feedback-store.js";

export function mountAgentFeedbackRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    userAuth,
    adminAuth,
    requireScope,
    logRequest,
    sanitizeWorkspace,
  } = deps;

  // 30 req/min per userId (falls back to IP when userId absent).
  const feedbackLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `feedback:${req.userId || req.ip}`,
  });

  /* ----------------------------- user routes ----------------------------- */

  apiRoute(
    "post",
    "/agent/feedback",
    logRequest,
    userAuth,
    requireScope("write"),
    feedbackLimiter,
    async (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const workspace = sanitizeWorkspace(body.workspace || "default");
      const userId = req.userId || "anonymous";
      try {
        const stored = await recordFeedback(workspace, {
          runId: body.runId,
          sessionId: body.sessionId,
          rating: body.rating,
          score: body.score,
          tags: body.tags,
          comment: body.comment,
          agentResponse: body.agentResponse,
          userId,
        });
        return res.status(200).json(stored);
      } catch (err) {
        const msg = String(err?.message || err);
        if (msg.startsWith("invalid feedback event")) {
          return apiError(res, 400, "INVALID_FEEDBACK", msg, "Fix the body and retry.");
        }
        return apiError(res, 500, "INTERNAL", msg);
      }
    },
  );

  apiRoute(
    "get",
    "/agent/feedback",
    logRequest,
    userAuth,
    requireScope("read"),
    async (req, res) => {
      const runId = typeof req.query?.runId === "string" ? req.query.runId.trim() : "";
      if (!runId) {
        return apiError(res, 400, "MISSING_RUN_ID", "runId query param required", "");
      }
      const workspace = sanitizeWorkspace(req.query?.workspace || "default");
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 50));
      try {
        const events = await listFeedback(workspace, { runId, limit });
        return res.json({ workspace, runId, total: events.length, events });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  /* ----------------------------- admin routes ---------------------------- */

  apiRoute(
    "get",
    "/admin/agent-feedback",
    logRequest,
    adminAuth,
    requireScope("admin"),
    async (req, res) => {
      const workspace = sanitizeWorkspace(req.query?.workspace || "default");
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 50));
      const rating = req.query?.rating === "up" || req.query?.rating === "down"
        ? req.query.rating
        : undefined;
      const runId = typeof req.query?.runId === "string" && req.query.runId.trim()
        ? req.query.runId.trim()
        : undefined;
      try {
        const events = await listFeedback(workspace, { limit, rating, runId });
        return res.json({ workspace, total: events.length, events });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  apiRoute(
    "get",
    "/admin/agent-feedback/aggregate",
    logRequest,
    adminAuth,
    requireScope("admin"),
    async (req, res) => {
      const workspace = sanitizeWorkspace(req.query?.workspace || "default");
      const sinceTs = Number(req.query?.sinceTs);
      try {
        const agg = await aggregateFeedback(
          workspace,
          Number.isFinite(sinceTs) && sinceTs > 0 ? { sinceTs } : {},
        );
        return res.json({ workspace, ...agg });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );

  apiRoute(
    "delete",
    "/admin/agent-feedback",
    logRequest,
    adminAuth,
    requireScope("admin"),
    async (req, res) => {
      const workspace = sanitizeWorkspace(req.query?.workspace || "default");
      try {
        await clearFeedback(workspace);
        return res.json({ ok: true, workspace });
      } catch (err) {
        return apiError(res, 500, "INTERNAL", String(err?.message || err));
      }
    },
  );
}

export default mountAgentFeedbackRoutes;
