/**
 * Phase 66.4: Tenant encryption routes.
 *
 * POST   /api/v1/tenant-encryption/:tenantId          -- create key
 * POST   /api/v1/tenant-encryption/:tenantId/rotate   -- rotate key
 * POST   /api/v1/tenant-encryption/:tenantId/encrypt  -- { plaintext }
 * POST   /api/v1/tenant-encryption/:tenantId/decrypt  -- payload
 * GET    /api/v1/tenant-encryption                    -- list all (metadata)
 * GET    /api/v1/tenant-encryption/:tenantId          -- list one
 * DELETE /api/v1/tenant-encryption/:tenantId          -- crypto-shred
 */
import {
  createTenantKey,
  rotateTenantKey,
  encryptForTenant,
  decryptForTenant,
  listKeys,
  deleteTenantKeys,
} from "../lib/tenant-encryption.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "tenant-encryption error");
}

function classify(err) {
  const msg = err?.message || "";
  if (msg.includes("already has")) return 409;
  if (msg.includes("has no keys") || msg.includes("not found")) return 404;
  if (msg.includes("required") || msg.includes("malformed") || msg.includes("invalid")) return 400;
  return 500;
}

export function mountTenantEncryptionRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/tenant-encryption/:tenantId", log, admin, async (req, res) => {
    try {
      const rec = await createTenantKey(req.params.tenantId);
      return res.status(201).json({ _version: 1, key: rec });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("post", "/tenant-encryption/:tenantId/rotate", log, admin, async (req, res) => {
    try {
      const rec = await rotateTenantKey(req.params.tenantId);
      return res.json({ _version: 1, rotation: rec });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("post", "/tenant-encryption/:tenantId/encrypt", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.plaintext !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "plaintext string required");
      }
      const payload = await encryptForTenant(req.params.tenantId, body.plaintext);
      return res.json({ _version: 1, payload });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("post", "/tenant-encryption/:tenantId/decrypt", log, auth, scope("write"), async (req, res) => {
    try {
      const plaintext = await decryptForTenant(req.params.tenantId, req.body || {});
      return res.json({ _version: 1, plaintext });
    } catch (err) {
      return sendError(apiError, res, err, classify(err));
    }
  });

  apiRoute("get", "/tenant-encryption", log, admin, async (_req, res) => {
    try {
      const items = await listKeys();
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/tenant-encryption/:tenantId", log, admin, async (req, res) => {
    try {
      const items = await listKeys(req.params.tenantId);
      if (items.length === 0) return apiError(res, 404, "NOT_FOUND", `tenant ${req.params.tenantId} has no keys`);
      return res.json({ _version: 1, tenant: items[0] });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("delete", "/tenant-encryption/:tenantId", log, admin, async (req, res) => {
    try {
      const ok = await deleteTenantKeys(req.params.tenantId);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `tenant ${req.params.tenantId} has no keys`);
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountTenantEncryptionRoutes;
