/**
 * Phase 67.4: Brand safety routes.
 *
 * POST   /api/v1/brand-safety/rule-sets              -- create
 * GET    /api/v1/brand-safety/rule-sets              -- list
 * PUT    /api/v1/brand-safety/rule-sets/:id          -- update
 * DELETE /api/v1/brand-safety/rule-sets/:id          -- delete
 * POST   /api/v1/brand-safety/rule-sets/:id/evaluate -- { text, topics? }
 * POST   /api/v1/brand-safety/test                   -- inline { ruleSet, content }
 */
import {
  createRuleSet,
  evaluateContent,
  listRuleSets,
  updateRuleSet,
  testContent,
  deleteRuleSet,
} from "../lib/brand-safety.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "brand-safety error");
}

export function mountBrandSafetyRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope, adminAuth } = deps;
  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;
  const admin = typeof adminAuth === "function" ? adminAuth : noopAuth;

  apiRoute("post", "/brand-safety/rule-sets", log, admin, async (req, res) => {
    try {
      const rs = await createRuleSet(req.body || {});
      return res.status(201).json({ _version: 1, ruleSet: rs });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/brand-safety/rule-sets", log, auth, scope("read"), async (req, res) => {
    try {
      const brand = typeof req.query.brand === "string" ? req.query.brand : undefined;
      const enabledOnly = req.query.enabledOnly === "1" || req.query.enabledOnly === "true";
      const items = await listRuleSets({ brand, enabledOnly });
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("put", "/brand-safety/rule-sets/:id", log, admin, async (req, res) => {
    try {
      const rs = await updateRuleSet(req.params.id, req.body || {});
      return res.json({ _version: 1, ruleSet: rs });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not found") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("delete", "/brand-safety/rule-sets/:id", log, admin, async (req, res) => {
    try {
      const ok = await deleteRuleSet(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `rule set ${req.params.id} not found`);
      return res.json({ _version: 1, deleted: true });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/brand-safety/rule-sets/:id/evaluate", log, auth, scope("read"), async (req, res) => {
    try {
      const result = await evaluateContent(req.params.id, req.body || {});
      return res.json({ _version: 1, result });
    } catch (err) {
      const msg = err?.message || "";
      const status = msg.includes("not found") ? 404 : 400;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/brand-safety/test", log, auth, scope("read"), async (req, res) => {
    try {
      const result = testContent(req.body || {});
      return res.json({ _version: 1, result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountBrandSafetyRoutes;
