/**
 * Phase 51.5: Risky-ops quota routes.
 *
 * GET    /api/v1/risky-ops/tiers                  — list known tiers + tools
 * GET    /api/v1/risky-ops/quota/check            — check (does not consume)
 * POST   /api/v1/risky-ops/quota/consume          — consume a slot
 * POST   /api/v1/risky-ops/operations/:op/tier    — retag an operation
 * GET    /api/v1/risky-ops/counters               — active counter snapshot
 */
import {
  RISKY_TIERS,
  TOOL_TIERS,
  getOperationTier,
  tagOperation,
  checkQuota,
  consumeQuota,
  listCounters,
} from "../lib/risky-ops-quota.js";

export function mountRiskyOpsQuotaRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  apiRoute("get", "/risky-ops/tiers", adminAuth, logRequest, async (req, res) => {
    res.json({ tiers: RISKY_TIERS, tools: TOOL_TIERS });
  });

  apiRoute("get", "/risky-ops/quota/check", adminAuth, logRequest, async (req, res) => {
    try {
      const operation = req.query?.operation;
      const subject = req.query?.subject || "anon";
      if (!operation) return apiError(res, 400, "INVALID_INPUT", "operation query param is required");
      const q = checkQuota(String(operation), String(subject));
      res.json(q);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/risky-ops/quota/consume", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.operation) return apiError(res, 400, "INVALID_INPUT", "operation is required");
      const q = consumeQuota(String(body.operation), String(body.subject || "anon"));
      if (!q.allowed) {
        return res.status(429).json({
          error: `Rate limit exceeded for ${q.tier} tier`,
          code: "RATE_LIMITED",
          ...q,
        });
      }
      res.json(q);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/risky-ops/operations/:op/tier", adminAuth, logRequest, async (req, res) => {
    try {
      const tier = req.body?.tier;
      if (!RISKY_TIERS.includes(tier)) {
        return apiError(res, 400, "INVALID_INPUT", `tier must be one of ${RISKY_TIERS.join(", ")}`);
      }
      tagOperation(req.params.op, tier);
      res.json({ operation: req.params.op, tier: getOperationTier(req.params.op) });
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/risky-ops/counters", adminAuth, logRequest, async (req, res) => {
    res.json({ counters: listCounters() });
  });
}

export default mountRiskyOpsQuotaRoutes;
