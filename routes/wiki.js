/**
 * Repo wiki routes — auto-generated repository documentation.
 */
import {
  generateWiki,
  getWiki,
  getWikiPage,
  listWikiPages,
  invalidateWiki,
} from "../lib/repo-wiki-generator.js";

export function mountWikiRoutes(app, deps) {
  const { dualRegister, apiError } = deps;
  const reg = dualRegister || ((path, handler) => { app.use(path, handler); });

  app.get("/api/v1/workspaces/:workspaceId/wiki", async (req, res) => {
    try {
      const wiki = await getWiki(req.params.workspaceId);
      if (!wiki) return res.json({ status: "pending", pages: [] });
      const pages = await listWikiPages(req.params.workspaceId);
      res.json({ wikiId: wiki.wikiId, status: wiki.status, generatedAt: wiki.generatedAt, indexedFiles: wiki.indexedFiles, pages });
    } catch (e) {
      apiError(res, 500, e.message);
    }
  });

  app.get("/api/v1/workspaces/:workspaceId/wiki/:slug", async (req, res) => {
    try {
      const page = await getWikiPage(req.params.workspaceId, req.params.slug);
      if (!page) return apiError(res, 404, "Page not found");
      res.json(page);
    } catch (e) {
      apiError(res, 500, e.message);
    }
  });

  app.post("/api/v1/workspaces/:workspaceId/wiki/generate", async (req, res) => {
    try {
      const ctx = { workspaceFilesystemRoot: req.body?.workspaceRoot || process.env.WORKSPACE_ROOT || "" };
      const llmClient = deps.llmClient || null;
      res.status(202).json({ status: "generating", workspaceId: req.params.workspaceId });
      generateWiki(req.params.workspaceId, ctx, llmClient, req.body || {}).catch(() => {});
    } catch (e) {
      apiError(res, 500, e.message);
    }
  });

  app.post("/api/v1/workspaces/:workspaceId/wiki/invalidate", async (req, res) => {
    try {
      const result = await invalidateWiki(req.params.workspaceId);
      res.json({ ok: true, status: result.status });
    } catch (e) {
      apiError(res, 500, e.message);
    }
  });
}
