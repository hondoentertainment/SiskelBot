/**
 * Phase 53.3: Progressive tool disclosure routes.
 *
 * POST /api/v1/tools/disclosure-progressive/select
 *   body { task, tools, budget, minTools?, pinned?, reserveTokens?, usage? }
 * POST /api/v1/tools/disclosure-progressive/rank
 *   body { task, tools, usage? }
 * POST /api/v1/tools/disclosure-progressive/estimate
 *   body { tool }
 * POST /api/v1/tools/disclosure-progressive/prune
 *   body { tools, keep }
 * GET  /api/v1/tools/disclosure-progressive/pins
 * PUT  /api/v1/tools/disclosure-progressive/pins   -- body { names }
 */
import {
  estimateToolTokenCost,
  rankByRelevance,
  selectToolsForBudget,
  pruneToolSet,
  getPinnedTools,
  setPinnedTools,
} from "../lib/tool-disclosure-progressive.js";

function sendError(apiError, res, err, status = 500) {
  const code =
    status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "tool-disclosure-progressive error");
}

export function mountToolDisclosureProgressiveRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/tools/disclosure-progressive/select
  apiRoute("post", "/tools/disclosure-progressive/select", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tools)) {
        return apiError(res, 400, "INVALID_INPUT", "tools must be an array");
      }
      if (!Number.isFinite(body.budget)) {
        return apiError(res, 400, "INVALID_INPUT", "budget (number) is required");
      }
      const task = typeof body.task === "string" ? body.task : "";
      const pins = Array.isArray(body.pinned)
        ? body.pinned
        : body.usePersistedPins
        ? await getPinnedTools()
        : [];
      const result = selectToolsForBudget(task, body.tools, body.budget, {
        minTools: body.minTools,
        pinned: pins,
        reserveTokens: body.reserveTokens,
        usage: body.usage || {},
      });
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // POST /api/v1/tools/disclosure-progressive/rank
  apiRoute("post", "/tools/disclosure-progressive/rank", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tools)) {
        return apiError(res, 400, "INVALID_INPUT", "tools must be an array");
      }
      const ranked = rankByRelevance(
        typeof body.task === "string" ? body.task : "",
        body.tools,
        { usage: body.usage || {} },
      );
      return res.json({ _version: 1, ranked, count: ranked.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // POST /api/v1/tools/disclosure-progressive/estimate
  apiRoute("post", "/tools/disclosure-progressive/estimate", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.tool || typeof body.tool !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "tool is required");
      }
      const tokens = estimateToolTokenCost(body.tool);
      return res.json({ _version: 1, tokens });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // POST /api/v1/tools/disclosure-progressive/prune
  apiRoute("post", "/tools/disclosure-progressive/prune", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const kept = pruneToolSet(
        Array.isArray(body.tools) ? body.tools : [],
        Array.isArray(body.keep) ? body.keep : [],
      );
      return res.json({ _version: 1, tools: kept, count: kept.length });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  // GET /api/v1/tools/disclosure-progressive/pins
  apiRoute("get", "/tools/disclosure-progressive/pins", log, auth, scope("read"), async (_req, res) => {
    try {
      const pins = await getPinnedTools();
      return res.json({ _version: 1, pins });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // PUT /api/v1/tools/disclosure-progressive/pins
  apiRoute("put", "/tools/disclosure-progressive/pins", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.names)) {
        return apiError(res, 400, "INVALID_INPUT", "names must be an array");
      }
      const pins = await setPinnedTools(body.names);
      return res.json({ _version: 1, pins });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });
}

export default mountToolDisclosureProgressiveRoutes;
