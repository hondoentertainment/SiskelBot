/**
 * Phase 53.3: Progressive tool disclosure routes.
 *
 * POST   /api/v1/tools/disclose                              -- rank + select within budget
 * POST   /api/v1/tools/rank                                  -- rank only
 * POST   /api/v1/tools/tier                                  -- tier tools by usefulness
 * POST   /api/v1/tools/essential/:workspaceId                -- mark tool essential
 * GET    /api/v1/tools/essential/:workspaceId                -- list essential tools
 * DELETE /api/v1/tools/essential/:workspaceId/:toolName      -- unmark essential
 * GET    /api/v1/tools/disclose/stats/:workspaceId           -- disclosure stats
 * GET    /api/v1/tools/disclose/suggest/:workspaceId         -- pin suggestions
 */
import {
  discloseTools,
  rankToolsForDisclosure,
  tierTools,
  markEssential,
  unmarkEssential,
  getEssentialTools,
  getDisclosureStats,
  suggestPinning,
} from "../lib/tool-disclosure.js";

export function mountToolDisclosureRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();

  // POST /api/v1/tools/disclose
  apiRoute("post", "/tools/disclose", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tools)) {
        return apiError(res, 400, "INVALID_INPUT", "tools must be an array");
      }
      const context = body.context && typeof body.context === "object" ? body.context : {};
      const options = {};
      if (Number.isFinite(body.budget)) options.budget = body.budget;
      if (Number.isFinite(body.maxTools)) options.maxTools = body.maxTools;
      if (Number.isFinite(body.minRelevance)) options.minRelevance = body.minRelevance;
      if (Array.isArray(body.pinnedTools)) options.pinnedTools = body.pinnedTools;
      const result = await discloseTools(body.tools, context, options);
      return res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "disclose failed");
    }
  });

  // POST /api/v1/tools/rank
  apiRoute("post", "/tools/rank", log, (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tools)) {
        return apiError(res, 400, "INVALID_INPUT", "tools must be an array");
      }
      const context = body.context && typeof body.context === "object" ? body.context : {};
      const ranked = rankToolsForDisclosure(body.tools, context);
      return res.json({
        _version: 1,
        ranked: ranked.map((r) => ({
          name: r.name,
          score: r.score,
          relevance: r.relevance,
          uses: r.uses,
          tokens: r.tokens,
          essential: r.essential,
        })),
        count: ranked.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "rank failed");
    }
  });

  // POST /api/v1/tools/tier
  apiRoute("post", "/tools/tier", log, (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tools)) {
        return apiError(res, 400, "INVALID_INPUT", "tools must be an array");
      }
      const tiers = tierTools(body.tools);
      return res.json({
        _version: 1,
        essential: tiers.essential,
        commonly_used: tiers.commonly_used,
        rarely_used: tiers.rarely_used,
        counts: {
          essential: tiers.essential.length,
          commonly_used: tiers.commonly_used.length,
          rarely_used: tiers.rarely_used.length,
        },
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "tier failed");
    }
  });

  // POST /api/v1/tools/essential/:workspaceId
  apiRoute("post", "/tools/essential/:workspaceId", log, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.toolName || typeof body.toolName !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "toolName is required");
      }
      const wsId = req.params.workspaceId;
      const list = await markEssential(body.toolName, wsId);
      return res.status(201).json({ _version: 1, workspaceId: wsId, essential: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "markEssential failed");
    }
  });

  // GET /api/v1/tools/essential/:workspaceId
  apiRoute("get", "/tools/essential/:workspaceId", log, async (req, res) => {
    try {
      const wsId = req.params.workspaceId;
      const list = await getEssentialTools(wsId);
      return res.json({ _version: 1, workspaceId: wsId, essential: list, count: list.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "getEssentialTools failed");
    }
  });

  // DELETE /api/v1/tools/essential/:workspaceId/:toolName
  apiRoute("delete", "/tools/essential/:workspaceId/:toolName", log, async (req, res) => {
    try {
      const wsId = req.params.workspaceId;
      const name = req.params.toolName;
      const list = await unmarkEssential(name, wsId);
      return res.json({ _version: 1, workspaceId: wsId, essential: list });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "unmarkEssential failed");
    }
  });

  // GET /api/v1/tools/disclose/stats/:workspaceId
  apiRoute("get", "/tools/disclose/stats/:workspaceId", log, async (req, res) => {
    try {
      const wsId = req.params.workspaceId;
      const stats = await getDisclosureStats(wsId);
      return res.json({ _version: 1, workspaceId: wsId, ...stats });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "getDisclosureStats failed");
    }
  });

  // GET /api/v1/tools/disclose/suggest/:workspaceId
  apiRoute("get", "/tools/disclose/suggest/:workspaceId", log, async (req, res) => {
    try {
      const wsId = req.params.workspaceId;
      const suggestions = await suggestPinning(wsId);
      return res.json({
        _version: 1,
        workspaceId: wsId,
        suggestions,
        count: suggestions.length,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "suggestPinning failed");
    }
  });
}

export default mountToolDisclosureRoutes;
