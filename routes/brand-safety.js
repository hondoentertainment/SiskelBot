/**
 * Route module: brand safety (Phase 67.4).
 *
 * POST   /api/v1/brand-safety/rules           — createRule
 * GET    /api/v1/brand-safety/rules           — listRules
 * GET    /api/v1/brand-safety/rules/:id       — getRule
 * PATCH  /api/v1/brand-safety/rules/:id       — updateRule
 * DELETE /api/v1/brand-safety/rules/:id       — deleteRule
 * POST   /api/v1/brand-safety/evaluate        — evaluateContent
 */
import {
  createRule,
  getRule,
  listRules,
  updateRule,
  deleteRule,
  evaluateContent,
} from "../lib/brand-safety.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "") || /must/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountBrandSafetyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/brand-safety/rules", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const rec = await createRule({
        name: body.name,
        kind: body.kind,
        severity: body.severity,
        keywords: body.keywords,
        patterns: body.patterns,
        negators: body.negators,
        windowChars: body.windowChars,
        tags: body.tags,
        description: body.description,
        enabled: body.enabled,
      });
      res.status(201).json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/brand-safety/rules", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.kind) filter.kind = String(req.query.kind);
      if (req.query?.severity) filter.severity = String(req.query.severity);
      if (req.query?.tag) filter.tag = String(req.query.tag);
      if (req.query?.enabled != null) filter.enabled = String(req.query.enabled) === "true";
      const rules = await listRules(filter);
      res.json({ rules });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("get", "/brand-safety/rules/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await getRule(req.params.id);
      if (!rec) return apiError(res, 404, "NOT_FOUND", "rule not found");
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("patch", "/brand-safety/rules/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rec = await updateRule(req.params.id, req.body || {});
      res.json(rec);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("delete", "/brand-safety/rules/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteRule(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "rule not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  apiRoute("post", "/brand-safety/evaluate", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await evaluateContent(body.content, { ruleIds: body.ruleIds });
      res.json(result);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountBrandSafetyRoutes;
