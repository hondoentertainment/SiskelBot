/**
 * Phase 65.2: Usage policy routes.
 *
 * POST   /api/v1/usage-policies              -- create
 * GET    /api/v1/usage-policies              -- list
 * GET    /api/v1/usage-policies/:id          -- get
 * PUT    /api/v1/usage-policies/:id          -- update
 * DELETE /api/v1/usage-policies/:id          -- delete
 * POST   /api/v1/usage-policies/:id/evaluate -- evaluate { ctx }
 * POST   /api/v1/usage-policies/test         -- test { policy, ctx } without persisting
 */
import {
  createPolicy,
  evaluatePolicy,
  listPolicies,
  updatePolicy,
  testPolicy,
  deletePolicy,
  getPolicy,
} from "../lib/usage-policies.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "usage-policies error");
}

export function mountUsagePoliciesRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/usage-policies", log, admin, async (req, res) => {
    try {
      const p = await createPolicy(req.body || {});
      return res.status(201).json({ _version: 1, policy: p });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/usage-policies", log, auth, scope("read"), async (req, res) => {
    try {
      const department = typeof req.query.department === "string" ? req.query.department : undefined;
      const enabledOnly = req.query.enabledOnly === "1" || req.query.enabledOnly === "true";
      const items = await listPolicies({ department, enabledOnly });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/usage-policies/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const p = await getPolicy(req.params.id);
      if (!p) return apiError(res, 404, "NOT_FOUND", `policy ${req.params.id} not found`);
      return res.json({ _version: 1, policy: p });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("put", "/usage-policies/:id", log, admin, async (req, res) => {
    try {
      const p = await updatePolicy(req.params.id, req.body || {});
      return res.json({ _version: 1, policy: p });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not found") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("delete", "/usage-policies/:id", log, admin, async (req, res) => {
    try {
      const ok = await deletePolicy(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `policy ${req.params.id} not found`);
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/usage-policies/:id/evaluate", log, auth, scope("read"), async (req, res) => {
    try {
      const ctx = (req.body && typeof req.body === "object" && req.body.ctx) || {};
      const result = await evaluatePolicy(req.params.id, ctx);
      return res.json({ _version: 1, result });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not found") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/usage-policies/test", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.policy || typeof body.policy !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "policy is required");
      }
      const result = testPolicy(body.policy, body.ctx || {});
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountUsagePoliciesRoutes;
