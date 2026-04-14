/**
 * Phase 71.1: Pricing engine routes.
 *
 * POST   /api/v1/pricing/rules       — create or upsert a rule
 * GET    /api/v1/pricing/rules       — list rules for a workspace
 * GET    /api/v1/pricing/rules/:id   — get a single rule
 * DELETE /api/v1/pricing/rules/:id   — delete a rule
 * POST   /api/v1/pricing/compute     — compute cost for a usage record
 */
import {
  createPricingRule,
  listPricingRules,
  getPricingRule,
  deletePricingRule,
  computeCost,
  PRICING_UNITS,
} from "../lib/pricing-engine.js";

export function mountPricingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("post", "/pricing/rules", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!PRICING_UNITS.includes(body.unit)) {
        return apiError(res, 400, "INVALID_INPUT", `unit must be one of ${PRICING_UNITS.join(", ")}`);
      }
      const rule = await createPricingRule(body);
      res.status(201).json(rule);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/pricing/rules", adminAuth, logRequest, async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId || "default";
      const rules = await listPricingRules(workspaceId);
      res.json({ workspaceId, rules });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/pricing/rules/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const rule = await getPricingRule(req.params?.id);
      if (!rule) return apiError(res, 404, "NOT_FOUND", "pricing rule not found");
      res.json(rule);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("delete", "/pricing/rules/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const ok = await deletePricingRule(req.params?.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", "pricing rule not found");
      res.json({ deleted: true, ruleId: req.params?.id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/pricing/compute", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await computeCost({ workspaceId: body.workspaceId, usage: body.usage || {} });
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountPricingRoutes;
