/**
 * Route module: dataset management for ML training (Phase 38.2).
 *
 * GET    /api/v1/datasets                   — list datasets
 * POST   /api/v1/datasets                   — create dataset
 * GET    /api/v1/datasets/:id               — get dataset (optional ?version=)
 * DELETE /api/v1/datasets/:id               — delete dataset
 * POST   /api/v1/datasets/:id/examples      — add examples (creates a new version)
 * DELETE /api/v1/datasets/:id/examples      — remove examples (creates a new version)
 * GET    /api/v1/datasets/:id/versions      — list version history
 * POST   /api/v1/datasets/:id/tag           — tag a version
 * POST   /api/v1/datasets/:id/split         — deterministic split
 * GET    /api/v1/datasets/:id/export        — export to a given format
 * POST   /api/v1/datasets/import            — import a dataset
 * GET    /api/v1/datasets/:id/stats         — compute summary statistics
 */

import {
  createDataset,
  addExamples,
  removeExamples,
  listDatasets,
  getDataset,
  deleteDataset,
  tagDataset,
  splitDataset,
  getDatasetVersions,
  exportDataset,
  importDataset,
  getDatasetStats,
} from "../lib/dataset-manager.js";

export function mountDatasetRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/datasets
  apiRoute("get", "/datasets", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace || "default";
      const result = await listDatasets(workspace);
      res.json({ datasets: result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/datasets
  apiRoute("post", "/datasets", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { name, description, workspace } = req.body || {};
      if (!name || typeof name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required.");
      }
      const workspaceId = workspace || req.query?.workspace || "default";
      const result = await createDataset(name, description || "", workspaceId);
      if (result.error) {
        return apiError(res, 400, result.code || "INVALID_INPUT", result.error);
      }
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/datasets/:id
  apiRoute("get", "/datasets/:id", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const version = req.query?.version;
      const workspace = req.query?.workspace;
      const result = await getDataset(req.params.id, version, workspace);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/datasets/:id
  apiRoute("delete", "/datasets/:id", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace;
      const result = await deleteDataset(req.params.id, workspace);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/datasets/:id/examples
  apiRoute("post", "/datasets/:id/examples", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { examples, metadata } = req.body || {};
      if (!Array.isArray(examples)) {
        return apiError(res, 400, "INVALID_INPUT", "examples must be an array.");
      }
      const result = await addExamples(req.params.id, examples, metadata || {});
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/datasets/:id/examples
  apiRoute("delete", "/datasets/:id/examples", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { exampleIds } = req.body || {};
      if (!Array.isArray(exampleIds)) {
        return apiError(res, 400, "INVALID_INPUT", "exampleIds must be an array.");
      }
      const result = await removeExamples(req.params.id, exampleIds);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/datasets/:id/versions
  apiRoute("get", "/datasets/:id/versions", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace;
      const result = await getDatasetVersions(req.params.id, workspace);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json({ versions: result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/datasets/:id/tag
  apiRoute("post", "/datasets/:id/tag", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { version, tag } = req.body || {};
      if (!version || typeof version !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "version is required.");
      }
      if (!tag || typeof tag !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "tag is required.");
      }
      const result = await tagDataset(req.params.id, version, tag);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/datasets/:id/split
  apiRoute("post", "/datasets/:id/split", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const ratios = req.body?.ratios || { train: 0.8, val: 0.1, test: 0.1 };
      const result = await splitDataset(req.params.id, ratios);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/datasets/:id/export
  apiRoute("get", "/datasets/:id/export", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const format = req.query?.format || "jsonl";
      const result = await exportDataset(req.params.id, format);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code || "INVALID_INPUT", result.error);
      }
      res.setHeader("Content-Type", result.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="dataset-${req.params.id}.${result.format}"`,
      );
      res.send(result.data);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/datasets/import
  apiRoute("post", "/datasets/import", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const { name, content, format, description, workspace } = req.body || {};
      if (!name || typeof name !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "name is required.");
      }
      if (content == null) {
        return apiError(res, 400, "INVALID_INPUT", "content is required.");
      }
      const workspaceId = workspace || req.query?.workspace || "default";
      const result = await importDataset(name, content, format || "jsonl", workspaceId, description);
      if (result?.error) {
        return apiError(res, 400, result.code || "INVALID_INPUT", result.error);
      }
      res.status(201).json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/datasets/:id/stats
  apiRoute("get", "/datasets/:id/stats", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.query?.workspace;
      const result = await getDatasetStats(req.params.id, workspace);
      if (result?.error) {
        const status = result.code === "NOT_FOUND" ? 404 : 400;
        return apiError(res, status, result.code, result.error);
      }
      res.json(result);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}
