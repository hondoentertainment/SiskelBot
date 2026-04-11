/**
 * Phase 46.4: Group synchronization routes.
 *
 *   GET    /api/v1/group-sync/rules?workspace=X
 *   POST   /api/v1/group-sync/rules                — create (admin)
 *   PUT    /api/v1/group-sync/rules/:id            — update (admin)
 *   DELETE /api/v1/group-sync/rules/:id            — delete (admin)
 *   POST   /api/v1/group-sync/rules/:id/test       — dry-run a rule
 *   POST   /api/v1/group-sync/users/:id/sync       — sync a single user (admin)
 *   POST   /api/v1/group-sync/run?source=ldap      — full sync (admin)
 *   GET    /api/v1/group-sync/history              — recent run history
 */
import {
  createGroupSyncRule,
  listGroupSyncRules,
  getGroupSyncRule,
  updateGroupSyncRule,
  deleteGroupSyncRule,
  syncUserGroups,
  runFullGroupSync,
  getGroupSyncHistory,
  testGroupSyncRule,
} from "../lib/group-sync.js";

export function mountGroupSyncRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    adminAuth,
    userAuth,
    requireScope,
    storageRateLimiter,
    logRequest,
  } = deps;

  const limiter = storageRateLimiter || ((_req, _res, next) => next());
  const logged = logRequest || ((_req, _res, next) => next());

  // ── List rules ────────────────────────────────────────────────────────
  apiRoute("get", "/group-sync/rules", limiter, userAuth, requireScope("read"), logged, async (req, res) => {
    try {
      const workspace = req.query?.workspace ? String(req.query.workspace) : undefined;
      const items = await listGroupSyncRules(workspace);
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── Create rule (admin) ───────────────────────────────────────────────
  apiRoute("post", "/group-sync/rules", limiter, adminAuth, logged, async (req, res) => {
    try {
      const created = await createGroupSyncRule({
        ...(req.body || {}),
        createdBy: req.userId || req.adminUser || null,
      });
      res.status(201).json(created);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // ── Update rule (admin) ───────────────────────────────────────────────
  apiRoute("put", "/group-sync/rules/:id", limiter, adminAuth, logged, async (req, res) => {
    try {
      const existing = await getGroupSyncRule(req.params.id);
      if (!existing) return apiError(res, 404, "NOT_FOUND", "rule not found");
      const updated = await updateGroupSyncRule(req.params.id, req.body || {});
      res.json(updated);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // ── Delete rule (admin) ───────────────────────────────────────────────
  apiRoute("delete", "/group-sync/rules/:id", limiter, adminAuth, logged, async (req, res) => {
    try {
      const result = await deleteGroupSyncRule(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "rule not found");
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // ── Dry-run a rule ────────────────────────────────────────────────────
  apiRoute("post", "/group-sync/rules/:id/test", limiter, adminAuth, logged, async (req, res) => {
    try {
      const rule = await getGroupSyncRule(req.params.id);
      if (!rule) return apiError(res, 404, "NOT_FOUND", "rule not found");
      const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
      const result = testGroupSyncRule(rule, groups);
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // ── Sync a single user (admin) ────────────────────────────────────────
  apiRoute("post", "/group-sync/users/:id/sync", limiter, adminAuth, logged, async (req, res) => {
    try {
      const userId = req.params.id;
      const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
      const source = String(req.body?.source || "ldap");
      const result = await syncUserGroups(userId, groups, source);
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // ── Full sync run (admin) ─────────────────────────────────────────────
  apiRoute("post", "/group-sync/run", limiter, adminAuth, logged, async (req, res) => {
    try {
      const source = String(req.query?.source || req.body?.source || "ldap");
      const result = await runFullGroupSync(source);
      res.json(result);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  // ── Run history ───────────────────────────────────────────────────────
  apiRoute("get", "/group-sync/history", limiter, userAuth, requireScope("read"), logged, async (req, res) => {
    try {
      const source = req.query?.source ? String(req.query.source) : undefined;
      const limit = req.query?.limit ? Number(req.query.limit) : undefined;
      const items = await getGroupSyncHistory({ source, limit });
      res.json({ _version: 1, items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountGroupSyncRoutes;
