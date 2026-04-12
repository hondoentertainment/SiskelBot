/**
 * Route module: heap snapshot + diff (Phase 60.2).
 *
 * POST   /api/v1/heap-diff/snapshots               — take a new heap snapshot
 * GET    /api/v1/heap-diff/snapshots               — list snapshots
 * GET    /api/v1/heap-diff/snapshots/:id           — fetch one
 * DELETE /api/v1/heap-diff/snapshots/:id           — delete
 * POST   /api/v1/heap-diff/diff                    — diff two snapshots by id
 *
 * All routes require an admin-scoped API key.
 */

import {
  takeSnapshot,
  getSnapshot,
  listSnapshots,
  deleteSnapshot,
  diffSnapshots,
} from "../lib/heap-diff.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (err?.code === "PARSE_FAILED") return { status: 500, code: "PARSE_FAILED" };
  if (/required/i.test(err?.message || "")) return { status: 400, code: "INVALID_INPUT" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountHeapDiffRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /api/v1/heap-diff/snapshots
  apiRoute("post", "/heap-diff/snapshots", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await takeSnapshot({
        label: body.label,
        tag: body.tag,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/heap-diff/snapshots
  apiRoute("get", "/heap-diff/snapshots", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (typeof req.query?.tag === "string") filter.tag = req.query.tag;
      const snapshots = await listSnapshots(filter);
      res.json({ snapshots });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/heap-diff/snapshots/:id
  apiRoute("get", "/heap-diff/snapshots/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getSnapshot(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "snapshot not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // DELETE /api/v1/heap-diff/snapshots/:id
  apiRoute("delete", "/heap-diff/snapshots/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteSnapshot(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "snapshot not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/heap-diff/diff
  apiRoute("post", "/heap-diff/diff", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const { beforeId, afterId, topN, minDelta } = body;
      if (!beforeId || !afterId) {
        return apiError(res, 400, "INVALID_INPUT", "beforeId and afterId are required");
      }
      const diff = await diffSnapshots(beforeId, afterId, { topN, minDelta });
      res.json(diff);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountHeapDiffRoutes;
