/**
 * Phase 67.5: HITL moderation queue routes.
 *
 * POST   /api/v1/hitl-moderation              -- enqueue
 * GET    /api/v1/hitl-moderation              -- list (?status&priority&limit)
 * GET    /api/v1/hitl-moderation/stats        -- queue stats
 * POST   /api/v1/hitl-moderation/claim        -- { reviewer, id?, leaseMs? }
 * POST   /api/v1/hitl-moderation/:id/decide   -- { reviewer, decision, notes? }
 * POST   /api/v1/hitl-moderation/:id/release  -- release claim
 */
import {
  enqueueForReview,
  listQueue,
  claimItem,
  decideItem,
  getQueueStats,
  releaseItem,
} from "../lib/hitl-moderation.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "hitl-moderation error");
}

function classify(err) {
  const msg = err?.message || "";
  if (msg.includes("not found")) return 404;
  if (msg.includes("required") || msg.includes("must") || msg.includes("unknown") || msg.includes("not claimable") || msg.includes("is not claimed")) return 400;
  return 500;
}

export function mountHitlModerationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/hitl-moderation", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await enqueueForReview(req.body || {});
      return res.status(201).json({ _version: 1, item: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/hitl-moderation", log, auth, scope("read"), async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const priority = typeof req.query.priority === "string" ? req.query.priority : undefined;
      const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
      const limit = Number(req.query.limit);
      const items = await listQueue({
        status,
        priority,
        workspaceId,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/hitl-moderation/stats", log, admin, async (_req, res) => {
    try {
      const stats = await getQueueStats();
      return res.json({ _version: 1, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/hitl-moderation/claim", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.reviewer) return apiError(res, 400, "INVALID_INPUT", "reviewer required");
      const rec = await claimItem(body);
      if (!rec) return res.status(204).end();
      return res.json({ _version: 1, item: rec });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("post", "/hitl-moderation/:id/decide", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await decideItem({ ...body, id: req.params.id });
      return res.json({ _version: 1, item: rec });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("post", "/hitl-moderation/:id/release", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await releaseItem({ id: req.params.id, reviewer: body.reviewer });
      return res.json({ _version: 1, item: rec });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });
}

export default mountHitlModerationRoutes;
