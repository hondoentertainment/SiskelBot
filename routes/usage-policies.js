/**
 * Route module: usage policies (Phase 65.2).
 *
 * POST   /api/v1/usage-policies             — createPolicy
 * GET    /api/v1/usage-policies             — listPolicies
 * GET    /api/v1/usage-policies/:id         — getPolicy
 * PATCH  /api/v1/usage-policies/:id         — updatePolicy
 * DELETE /api/v1/usage-policies/:id         — deletePolicy
 * POST   /api/v1/usage-policies/evaluate    — evaluatePolicy
 */
import {
  createPolicy,
  getPolicy,
  listPolicies,
  deletePolicy,
  updatePolicy,
  evaluatePolicy,
} from "../lib/usage-policies.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountUsagePoliciesRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/usage-policies", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await createPolicy({
        name: body.name,
        scope: body.scope,
        allow: body.allow,
        deny: body.deny,
        priority: body.priority,
        description: body.description,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/usage-policies", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.scopeKind) filter.scopeKind = String(req.query.scopeKind);
      if (req.query?.scopeId) filter.scopeId = String(req.query.scopeId);
      if (req.query?.name) filter.name = String(req.query.name);
      const policies = await listPolicies(filter);
      res.json({ policies });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/usage-policies/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getPolicy(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "policy not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("patch", "/usage-policies/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await updatePolicy(req.params.id, req.body || {});
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("delete", "/usage-policies/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deletePolicy(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "policy not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/usage-policies/evaluate", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const decision = await evaluatePolicy({
        subject: body.subject,
        resource: body.resource,
      });
      res.json(decision);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountUsagePoliciesRoutes;
