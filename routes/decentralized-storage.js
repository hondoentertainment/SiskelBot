/**
 * Phase 48.5: Decentralized storage (IPFS / Arweave) routes.
 *
 * POST   /api/v1/dstorage/upload                 — upload content, body: { data, provider, metadata }
 * GET    /api/v1/dstorage/download/:cid          — retrieve content, query: ?provider=
 * POST   /api/v1/dstorage/pin                    — pin an existing CID, body: { cid, provider }
 * DELETE /api/v1/dstorage/pin/:cid               — unpin
 * GET    /api/v1/dstorage/pinned                 — list pins (query: provider, workspaceId)
 * POST   /api/v1/dstorage/archive/:docId         — archive a knowledge document
 * GET    /api/v1/dstorage/providers              — list providers
 * GET    /api/v1/dstorage/providers/:name/health — provider health check
 */
import {
  uploadToStorage,
  downloadFromStorage,
  pinContent,
  unpinContent,
  listPinnedContent,
  archiveKnowledgeDocument,
  restoreFromDecentralized,
  checkProviderHealth,
  listProviders,
} from "../lib/decentralized-storage.js";

function mapErrorStatus(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  if (code === "INVALID_CID") return { status: 400, code: "INVALID_CID" };
  if (code === "UNKNOWN_PROVIDER") return { status: 400, code: "UNKNOWN_PROVIDER" };
  if (code === "NO_CLIENT") return { status: 400, code: "NO_CLIENT" };
  if (code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required|must be|invalid/i.test(msg)) return { status: 400, code: "INVALID_INPUT" };
  if (/not found/i.test(msg)) return { status: 404, code: "NOT_FOUND" };
  return { status: 500, code: "INTERNAL_ERROR" };
}

function sendError(apiError, res, err) {
  const { status, code } = mapErrorStatus(err);
  return apiError(res, status, code, err?.message || "decentralized-storage error");
}

export function mountDecentralizedStorageRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/dstorage/upload
  apiRoute("post", "/dstorage/upload", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (body.data == null || (typeof body.data !== "string" && !Buffer.isBuffer(body.data))) {
        return apiError(res, 400, "INVALID_INPUT", "data is required (string)");
      }
      const result = await uploadToStorage(body.data, {
        provider: body.provider,
        metadata: body.metadata || {},
        pinning: body.pinning !== false,
        workspaceId: body.workspaceId || req.workspaceId || null,
      });
      return res.status(201).json({ _version: 1, upload: result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/dstorage/download/:cid
  apiRoute("get", "/dstorage/download/:cid", log, auth, scope("read"), async (req, res) => {
    try {
      const provider = req.query?.provider;
      const result = await downloadFromStorage(req.params.cid, { provider });
      return res.json({ _version: 1, download: result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/dstorage/pin
  apiRoute("post", "/dstorage/pin", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.cid || typeof body.cid !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "cid is required");
      }
      const pin = await pinContent(body.cid, body.provider);
      return res.status(201).json({ _version: 1, pin });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // DELETE /api/v1/dstorage/pin/:cid
  apiRoute("delete", "/dstorage/pin/:cid", log, auth, scope("write"), async (req, res) => {
    try {
      const result = await unpinContent(req.params.cid, req.query?.provider);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/dstorage/pinned
  apiRoute("get", "/dstorage/pinned", log, auth, scope("read"), async (req, res) => {
    try {
      const pins = await listPinnedContent({
        provider: req.query?.provider,
        workspaceId: req.query?.workspaceId,
      });
      return res.json({ _version: 1, pins, count: pins.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/dstorage/archive/:docId
  apiRoute("post", "/dstorage/archive/:docId", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const workspaceId = body.workspaceId || req.workspaceId;
      if (!workspaceId) {
        return apiError(res, 400, "INVALID_INPUT", "workspaceId is required");
      }
      const result = await archiveKnowledgeDocument(req.params.docId, workspaceId, {
        provider: body.provider,
        content: body.content,
        title: body.title,
        metadata: body.metadata || {},
      });
      return res.status(201).json({ _version: 1, archive: result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/dstorage/restore/:cid
  apiRoute("get", "/dstorage/restore/:cid", log, auth, scope("read"), async (req, res) => {
    try {
      const result = await restoreFromDecentralized(req.params.cid, req.query?.provider);
      return res.json({ _version: 1, restore: result });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/dstorage/providers
  apiRoute("get", "/dstorage/providers", log, auth, scope("read"), async (_req, res) => {
    try {
      const providers = listProviders();
      return res.json({ _version: 1, providers, count: providers.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/dstorage/providers/:name/health
  apiRoute(
    "get",
    "/dstorage/providers/:name/health",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      try {
        const health = await checkProviderHealth(req.params.name);
        return res.json({ _version: 1, health });
      } catch (err) {
        return sendError(apiError, res, err);
      }
    },
  );
}

export default mountDecentralizedStorageRoutes;
