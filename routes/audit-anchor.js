/**
 * Phase 48.3: On-chain audit anchor admin routes.
 *
 * All endpoints are admin-only and mounted under /api/v1 (with the legacy
 * /api mirror) via the standard apiRoute() helper from server.js.
 *
 *   POST /audit/anchor/batch             - create a new anchor batch from audit events
 *   POST /audit/anchor/:batchId/submit   - submit a batch via a registered submitter
 *   GET  /audit/anchor/:batchId          - fetch the full batch record
 *   GET  /audit/anchors                  - list anchors (filter by chain/workspaceId)
 *   POST /audit/anchor/verify            - produce a Merkle proof for an audit event
 *   POST /audit/anchor/run               - trigger the scheduled anchoring job
 */
import {
  createAnchorBatch,
  submitAnchor,
  getAnchor,
  listAnchors,
  verifyAuditEvent,
  runAnchoringJob,
} from "../lib/audit-anchor.js";
import { queryAudit } from "../lib/audit-query.js";

export function mountAuditAnchorRoutes(app, deps) {
  const { apiRoute, apiError, adminAuth, logRequest } = deps;

  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const admin = typeof adminAuth === "function" ? adminAuth : (_req, _res, next) => next();

  // POST /audit/anchor/batch
  apiRoute("post", "/audit/anchor/batch", admin, log, async (req, res) => {
    try {
      const body = req.body || {};
      const chain = body.chain || "mock";
      const workspaceId = body.workspaceId || null;
      let events = Array.isArray(body.events) ? body.events : null;
      if (!events) {
        // Pull the most recent audit entries matching the optional filter.
        const limit = Number.isFinite(body.limit) ? Math.min(10000, Math.max(1, body.limit)) : 500;
        const q = await queryAudit({
          limit,
          workspaceId: workspaceId || undefined,
          userId: body.userId || undefined,
          action: body.action || undefined,
        });
        events = q?.entries || [];
      }
      const batch = await createAnchorBatch(events, { chain, workspaceId });
      return res.status(201).json({ _version: 1, batch });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "createAnchorBatch failed", null);
    }
  });

  // POST /audit/anchor/:batchId/submit
  apiRoute("post", "/audit/anchor/:batchId/submit", admin, log, async (req, res) => {
    try {
      const batchId = String(req.params.batchId || "").trim();
      if (!batchId) {
        return apiError(res, 400, "INVALID_INPUT", "batchId required", null);
      }
      const chain = req.body?.chain;
      const receipt = await submitAnchor(batchId, chain);
      return res.json({ _version: 1, receipt });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      const code = status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
      return apiError(res, status, code, err?.message || "submitAnchor failed", null);
    }
  });

  // GET /audit/anchor/:batchId
  apiRoute("get", "/audit/anchor/:batchId", admin, log, async (req, res) => {
    try {
      const batchId = String(req.params.batchId || "").trim();
      if (!batchId) {
        return apiError(res, 400, "INVALID_INPUT", "batchId required", null);
      }
      const record = await getAnchor(batchId);
      if (!record) {
        return apiError(res, 404, "NOT_FOUND", `anchor ${batchId} not found`, null);
      }
      return res.json({ _version: 1, anchor: record });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "getAnchor failed", null);
    }
  });

  // GET /audit/anchors
  apiRoute("get", "/audit/anchors", admin, log, async (req, res) => {
    try {
      const filter = {};
      if (req.query.chain) filter.chain = String(req.query.chain);
      if (req.query.workspaceId) filter.workspaceId = String(req.query.workspaceId);
      const anchors = await listAnchors(filter);
      return res.json({ _version: 1, anchors, count: anchors.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "listAnchors failed", null);
    }
  });

  // POST /audit/anchor/verify
  apiRoute("post", "/audit/anchor/verify", admin, log, async (req, res) => {
    try {
      const { eventId, anchorId } = req.body || {};
      if (!eventId || typeof eventId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "eventId required", null);
      }
      if (!anchorId || typeof anchorId !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "anchorId required", null);
      }
      const proof = await verifyAuditEvent(eventId, anchorId);
      if (!proof) {
        return apiError(res, 404, "NOT_FOUND", "event not found in anchor", null);
      }
      return res.json({ _version: 1, proof });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "verifyAuditEvent failed", null);
    }
  });

  // POST /audit/anchor/run
  apiRoute("post", "/audit/anchor/run", admin, log, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await runAnchoringJob({
        limit: Number.isFinite(body.limit) ? body.limit : undefined,
        workspaceId: body.workspaceId || undefined,
        chain: body.chain || undefined,
        submit: body.submit !== false,
      });
      return res.status(result.skipped ? 200 : 201).json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message || "runAnchoringJob failed", null);
    }
  });
}

export default mountAuditAnchorRoutes;
