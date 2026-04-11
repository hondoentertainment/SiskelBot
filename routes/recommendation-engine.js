/**
 * Phase 69.3: Recommendation engine routes.
 */
import {
  registerItem,
  recordInteraction,
  recommend,
  listItems,
  getItemStats,
} from "../lib/recommendation-engine.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "recommendation-engine error");
}

export function mountRecommendationEngineRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/recommendations/items", log, auth, scope("write"), async (req, res) => {
    try {
      const rec = await registerItem(req.body || {});
      return res.status(201).json({ _version: 1, item: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/recommendations/items", log, auth, scope("read"), async (_req, res) => {
    try {
      const items = await listItems();
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/recommendations/interactions", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.userId || !body.itemId) {
        return apiError(res, 400, "INVALID_INPUT", "userId and itemId are required");
      }
      const rec = await recordInteraction(body.userId, body.itemId, body);
      return res.status(201).json({ _version: 1, interaction: rec });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/recommendations/:userId", log, auth, scope("read"), async (req, res) => {
    try {
      const k = Number.isFinite(Number(req.query?.k)) ? Number(req.query.k) : 5;
      const r = await recommend(req.params.userId, { k });
      return res.json({ _version: 1, recommendations: r, count: r.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/recommendations/items/:id/stats", log, auth, scope("read"), async (req, res) => {
    try {
      const stats = await getItemStats(req.params.id);
      if (!stats) return apiError(res, 404, "NOT_FOUND", "item not found");
      return res.json({ _version: 1, stats });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountRecommendationEngineRoutes;
