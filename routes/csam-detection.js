/**
 * Phase 67.1: CSAM detection routes.
 *
 * POST   /api/v1/csam/hashes              -- { digest, list?, source?, notes? }
 * GET    /api/v1/csam/hashes              -- list entries (admin)
 * DELETE /api/v1/csam/hashes/:digest      -- remove entry
 * POST   /api/v1/csam/check               -- { digest }
 * POST   /api/v1/csam/scan                -- { digests: [] }
 */
import {
  addHashToList,
  checkHash,
  removeHash,
  listHashes,
  scanBatch,
} from "../lib/csam-detection.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "csam-detection error");
}

export function mountCsamDetectionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/csam/hashes", log, admin, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.digest) return apiError(res, 400, "INVALID_INPUT", "digest required");
      const rec = await addHashToList(body.digest, {
        list: body.list,
        source: body.source,
        notes: body.notes,
      });
      return res.status(201).json({ _version: 1, entry: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/csam/hashes", log, admin, async (req, res) => {
    try {
      const list = typeof req.query.list === "string" ? req.query.list : undefined;
      const source = typeof req.query.source === "string" ? req.query.source : undefined;
      const limit = Number(req.query.limit);
      const items = await listHashes({ list, source, limit: Number.isFinite(limit) ? limit : undefined });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/csam/hashes/:digest", log, admin, async (req, res) => {
    try {
      const ok = await removeHash(req.params.digest);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `hash ${req.params.digest} not found`);
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/csam/check", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.digest) return apiError(res, 400, "INVALID_INPUT", "digest required");
      const result = await checkHash(body.digest);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("post", "/csam/scan", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.digests)) {
        return apiError(res, 400, "INVALID_INPUT", "digests array required");
      }
      const result = await scanBatch(body.digests);
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountCsamDetectionRoutes;
