/**
 * Initiative engine routes — proactive proposals the bot generates on its own.
 * GET    /api/v1/initiatives            — list proposals (optional ?status=)
 * POST   /api/v1/initiatives/run        — run an initiative cycle now
 * GET    /api/v1/initiatives/:id        — get a single proposal
 * POST   /api/v1/initiatives/:id/approve — approve (optionally mark executed)
 * POST   /api/v1/initiatives/:id/dismiss — dismiss with a reason
 */
import {
  runInitiativeCycle,
  listProposals,
  getProposal,
  resolveProposal,
  llmCompleteFromBackend,
} from "../lib/initiative-engine.js";

export function mountInitiativeRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    storageRateLimiter,
    backendFetch,
    buildProxyConfig,
    resolveStorageUserId,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());

  function workspaceOf(req) {
    return req.headers["x-workspace-id"] || req.query?.workspace || req.body?.workspaceId || "default";
  }

  async function userOf(req, workspaceId) {
    if (typeof resolveStorageUserId === "function") {
      try {
        return await resolveStorageUserId(req.userId, workspaceId);
      } catch {
        /* fall through */
      }
    }
    return req.userId || "anonymous";
  }

  // GET /initiatives — list proposals
  apiRoute("get", "/initiatives", limiter, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      const status = typeof req.query?.status === "string" ? req.query.status : undefined;
      const limit = Math.min(Number(req.query?.limit) || 100, 200);
      const proposals = await listProposals(workspace, { status, limit });
      res.json({ ok: true, proposals });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /initiatives/run — run a cycle now
  apiRoute("post", "/initiatives/run", limiter, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      const userId = await userOf(req, workspace);
      const llmComplete = llmCompleteFromBackend({
        backendFetch,
        buildProxyConfig,
        model: req.body?.model,
      });
      const result = await runInitiativeCycle({
        workspaceId: workspace,
        llmComplete: llmComplete || undefined,
        providerOpts: { userId },
        maxProposals: Math.min(Number(req.body?.maxProposals) || 5, 20),
      });
      res.json({
        ok: true,
        created: result.created,
        createdCount: result.created.length,
        skipped: result.skipped,
        signalCount: result.signals.length,
        source: result.source,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /initiatives/:id — single proposal
  apiRoute("get", "/initiatives/:id", limiter, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      const proposal = await getProposal(workspace, req.params.id);
      if (!proposal) return apiError(res, 404, "NOT_FOUND", "Proposal not found");
      res.json({ ok: true, proposal });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /initiatives/:id/approve
  apiRoute("post", "/initiatives/:id/approve", limiter, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      const status = req.body?.executed ? "executed" : "approved";
      const updated = await resolveProposal(workspace, req.params.id, {
        status,
        by: req.userId || "user",
        resolution: req.body?.note,
      });
      if (!updated) return apiError(res, 404, "NOT_FOUND", "Proposal not found");
      res.json({ ok: true, proposal: updated });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /initiatives/:id/dismiss
  apiRoute("post", "/initiatives/:id/dismiss", limiter, async (req, res) => {
    try {
      const workspace = workspaceOf(req);
      const updated = await resolveProposal(workspace, req.params.id, {
        status: "dismissed",
        by: req.userId || "user",
        resolution: req.body?.reason,
      });
      if (!updated) return apiError(res, 404, "NOT_FOUND", "Proposal not found");
      res.json({ ok: true, proposal: updated });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
