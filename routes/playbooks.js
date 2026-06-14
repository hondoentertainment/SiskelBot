import {
  createPlaybook,
  updatePlaybook,
  deletePlaybook,
  getPlaybook,
  listPlaybooks,
  listGallery,
  publishToGallery,
  hydratePlaybook,
} from "../lib/playbooks.js";

export function mountPlaybookRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  apiRoute("post", "/workspaces/:workspaceId/playbooks", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const record = await createPlaybook(req.params.workspaceId, req.body || {});
      res.status(201).json(record);
    } catch (err) {
      return apiError(res, err.message.includes("limit") ? 409 : 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("get", "/workspaces/:workspaceId/playbooks", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const playbooks = await listPlaybooks(req.params.workspaceId);
      res.json({ playbooks });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/workspaces/:workspaceId/playbooks/:playbookId", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const pb = await getPlaybook(req.params.workspaceId, req.params.playbookId);
      if (!pb) return apiError(res, 404, "NOT_FOUND", "Playbook not found");
      res.json(pb);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("put", "/workspaces/:workspaceId/playbooks/:playbookId", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const updated = await updatePlaybook(req.params.workspaceId, req.params.playbookId, req.body || {});
      res.json(updated);
    } catch (err) {
      return apiError(res, err.message.includes("not found") ? 404 : 400, "INVALID_INPUT", err.message);
    }
  });

  apiRoute("delete", "/workspaces/:workspaceId/playbooks/:playbookId", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const result = await deletePlaybook(req.params.workspaceId, req.params.playbookId);
      res.json(result);
    } catch (err) {
      return apiError(res, err.message.includes("not found") ? 404 : 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/workspaces/:workspaceId/playbooks/:playbookId/publish", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const record = await publishToGallery(req.params.workspaceId, req.params.playbookId);
      res.json(record);
    } catch (err) {
      const status = err.message.includes("not found") ? 404 : err.message.includes("limit") ? 409 : 500;
      return apiError(res, status, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/playbooks/gallery", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const { tags, limit, offset } = req.query || {};
      const tagList = tags ? String(tags).split(",").map((t) => t.trim()).filter(Boolean) : undefined;
      const items = await listGallery({ tags: tagList, limit, offset });
      res.json({ playbooks: items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("post", "/playbooks/:playbookId/hydrate", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const { params, workspaceId } = req.body || {};
      const result = await hydratePlaybook(req.params.playbookId, params, workspaceId);
      res.json(result);
    } catch (err) {
      return apiError(res, err.message.includes("not found") ? 404 : 400, "INVALID_INPUT", err.message);
    }
  });
}

export default mountPlaybookRoutes;
