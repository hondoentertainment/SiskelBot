import { searchCodebase, findDefinition, findReferences } from "../lib/codebase-search.js";

export function mountCodebaseSearchRoutes(app, deps) {
  const { apiRoute, apiError, userAuth, requireScope, logRequest } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_s) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  function makeLlmClient(deps) {
    if (typeof deps.llmClient === "function") return deps.llmClient;
    if (typeof deps.chat === "function") return deps.chat;
    return null;
  }

  function buildCtx(req, workspaceId) {
    return {
      workspaceId,
      userId: req.userId || "anonymous",
      workspaceFilesystemRoot: req.workspaceFilesystemRoot || process.env.WORKSPACE_ROOT || "",
    };
  }

  apiRoute(
    "post",
    "/workspaces/:workspaceId/codebase-search",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      const { workspaceId } = req.params;
      const { query, model } = req.body || {};
      if (!query || typeof query !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "query is required");
      }
      try {
        const ctx = buildCtx(req, workspaceId);
        const llmClient = makeLlmClient(deps);
        const result = await searchCodebase(workspaceId, query, ctx, llmClient, { model });
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Search failed");
      }
    },
  );

  apiRoute(
    "post",
    "/workspaces/:workspaceId/codebase-search/definition",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      const { workspaceId } = req.params;
      const { symbol } = req.body || {};
      if (!symbol || typeof symbol !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "symbol is required");
      }
      try {
        const ctx = buildCtx(req, workspaceId);
        const result = await findDefinition(workspaceId, symbol, ctx);
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Definition lookup failed");
      }
    },
  );

  apiRoute(
    "post",
    "/workspaces/:workspaceId/codebase-search/references",
    log,
    auth,
    scope("read"),
    async (req, res) => {
      const { workspaceId } = req.params;
      const { symbol } = req.body || {};
      if (!symbol || typeof symbol !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "symbol is required");
      }
      try {
        const ctx = buildCtx(req, workspaceId);
        const result = await findReferences(workspaceId, symbol, ctx);
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err?.message || "References lookup failed");
      }
    },
  );
}
