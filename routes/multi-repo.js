import {
  listRepositories,
  addRepository,
  removeRepository,
} from "../lib/multi-repo-workspace.js";

export function mountMultiRepoRoutes(app, deps) {
  const { apiRoute, apiError, dualRegister } = deps;

  dualRegister("get", "/workspaces/:workspaceId/repositories", async (req, res) => {
    const { workspaceId } = req.params;
    try {
      const repositories = await listRepositories(workspaceId);
      res.json({ ok: true, repositories });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  dualRegister("post", "/workspaces/:workspaceId/repositories", async (req, res) => {
    const { workspaceId } = req.params;
    const { name, root, remoteUrl, branch } = req.body || {};
    if (!name) return apiError(res, 400, "INVALID_INPUT", "name is required");
    if (!root) return apiError(res, 400, "INVALID_INPUT", "root is required");
    try {
      const repo = await addRepository(workspaceId, { name, root, remoteUrl, branch });
      res.status(201).json({ ok: true, repository: repo });
    } catch (err) {
      if (err.message.includes("already exists") || err.message.includes("alphanumeric")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  dualRegister("delete", "/workspaces/:workspaceId/repositories/:name", async (req, res) => {
    const { workspaceId, name } = req.params;
    try {
      const removed = await removeRepository(workspaceId, name);
      if (!removed) return apiError(res, 404, "NOT_FOUND", "Repository not found");
      res.json({ ok: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
