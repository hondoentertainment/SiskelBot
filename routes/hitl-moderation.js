/**
 * Route module: HITL moderation queue (Phase 67.5).
 *
 * POST   /api/v1/hitl-moderation                      — enqueue
 * GET    /api/v1/hitl-moderation                      — listQueue
 * GET    /api/v1/hitl-moderation/:id                  — getItem
 * POST   /api/v1/hitl-moderation/claim                — claimItem
 * POST   /api/v1/hitl-moderation/:id/decide           — decideItem
 * POST   /api/v1/hitl-moderation/:id/release          — releaseClaim
 */
import {
  enqueue,
  getItem,
  listQueue,
  claimItem,
  decideItem,
  releaseClaim,
} from "../lib/hitl-moderation.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (err?.code === "INVALID_STATE") return { status: 409, code: "INVALID_STATE" };
  if (err?.code === "CONFLICT") return { status: 409, code: "CONFLICT" };
  if (err?.code === "FORBIDDEN") return { status: 403, code: "FORBIDDEN" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountHitlModerationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/hitl-moderation", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await enqueue({
        kind: body.kind,
        content: body.content,
        context: body.context,
        submittedBy: body.submittedBy,
        priority: body.priority,
        tags: body.tags,
        scannerHits: body.scannerHits,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/hitl-moderation", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.state) filter.state = String(req.query.state);
      if (req.query?.kind) filter.kind = String(req.query.kind);
      if (req.query?.reviewer) filter.reviewer = String(req.query.reviewer);
      const items = await listQueue(filter);
      res.json({ items });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/hitl-moderation/claim", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const item = await claimItem({
        reviewer: body.reviewer,
        itemId: body.itemId,
        ttlMs: body.ttlMs,
      });
      if (!item) return apiError(res, 404, "NOT_FOUND", "queue is empty");
      res.json(item);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/hitl-moderation/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getItem(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "item not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/hitl-moderation/:id/decide", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await decideItem(req.params.id, {
        reviewer: body.reviewer,
        decision: body.decision,
        reason: body.reason,
        metadata: body.metadata,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/hitl-moderation/:id/release", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await releaseClaim(req.params.id, {
        reviewer: body.reviewer,
        reason: body.reason,
      });
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountHitlModerationRoutes;
