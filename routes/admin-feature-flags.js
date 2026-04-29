/**
 * Admin: feature flag CRUD + client-facing evaluation.
 *
 * GET    /api/v1/admin/feature-flags         — list flags
 * GET    /api/v1/admin/feature-flags/:key    — get one
 * PUT    /api/v1/admin/feature-flags/:key    — create / update
 * DELETE /api/v1/admin/feature-flags/:key    — delete
 * GET    /api/v1/feature-flags/:key/evaluate — evaluate flag for current caller
 */
import { listFlags, setFlag, deleteFlag, getFlag } from "../lib/feature-flags.js";

const STORAGE_TYPE = "feature_flags";
const STORAGE_WORKSPACE = "default";
const STORAGE_USER = "system";

export default function mountAdminFeatureFlagRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth, requireScope, userAuth, storage } = deps;

  const adminGuard = requireScope ? [adminAuth, requireScope("admin")] : [adminAuth];

  apiRoute("get", "/admin/feature-flags", ...adminGuard, logRequest, async (_req, res) => {
    try {
      const flags = await listFlags(storage);
      res.json({ flags });
    } catch (err) {
      return apiError(res, 500, "FLAG_LIST_FAILED", err.message);
    }
  });

  apiRoute("get", "/admin/feature-flags/:key", ...adminGuard, logRequest, async (req, res) => {
    try {
      const key = String(req.params.key || "").trim();
      if (!key) return apiError(res, 400, "INVALID_INPUT", "Flag key required");
      const flag = await storage.getItem(STORAGE_TYPE, key, STORAGE_WORKSPACE, STORAGE_USER);
      if (!flag) return apiError(res, 404, "FLAG_NOT_FOUND", `No flag with key ${key}`);
      res.json(flag);
    } catch (err) {
      return apiError(res, 500, "FLAG_GET_FAILED", err.message);
    }
  });

  apiRoute("put", "/admin/feature-flags/:key", ...adminGuard, logRequest, async (req, res) => {
    try {
      const key = String(req.params.key || "").trim();
      if (!key) return apiError(res, 400, "INVALID_INPUT", "Flag key required");
      const flag = await setFlag(storage, key, req.body || {});
      res.json(flag);
    } catch (err) {
      return apiError(res, 400, "FLAG_SET_FAILED", err.message);
    }
  });

  apiRoute("delete", "/admin/feature-flags/:key", ...adminGuard, logRequest, async (req, res) => {
    try {
      const key = String(req.params.key || "").trim();
      if (!key) return apiError(res, 400, "INVALID_INPUT", "Flag key required");
      await deleteFlag(storage, key);
      res.status(204).send();
    } catch (err) {
      return apiError(res, 500, "FLAG_DELETE_FAILED", err.message);
    }
  });

  // Client-facing: evaluate a flag for the authenticated caller.
  const evalGuard = userAuth ? [userAuth] : [];
  apiRoute("get", "/feature-flags/:key/evaluate", ...evalGuard, logRequest, async (req, res) => {
    try {
      const key = String(req.params.key || "").trim();
      if (!key) return apiError(res, 400, "INVALID_INPUT", "Flag key required");
      const ctx = {
        userId: req.userId,
        workspaceId: req.query.workspace ? String(req.query.workspace) : undefined,
      };
      const value = await getFlag(storage, key, ctx);
      res.json({ key, value });
    } catch (err) {
      return apiError(res, 500, "FLAG_EVALUATE_FAILED", err.message);
    }
  });
}
