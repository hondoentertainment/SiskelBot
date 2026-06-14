/**
 * Phase 38.3: Model registry routes — CRUD for models, versions, deployments,
 * lineage, comparison, and model cards.
 *
 * Endpoints:
 *   GET    /api/v1/models                                         — list models
 *   POST   /api/v1/models                                         — register a model
 *   POST   /api/v1/models/search                                  — search models
 *   POST   /api/v1/models/compare                                 — compare two versions
 *   GET    /api/v1/models/deployments/:environment                — get deployed model
 *   POST   /api/v1/models/deployments/rollback                    — roll back deployment
 *   GET    /api/v1/models/:id                                     — get model detail
 *   GET    /api/v1/models/:id/versions                            — list versions
 *   POST   /api/v1/models/:id/versions                            — create version
 *   GET    /api/v1/models/:id/versions/:version                   — get version
 *   DELETE /api/v1/models/:id/versions/:version                   — delete version
 *   PUT    /api/v1/models/:id/versions/:version/status            — update status
 *   POST   /api/v1/models/:id/versions/:version/deploy            — deploy to env
 *   GET    /api/v1/models/:id/versions/:version/card              — markdown model card
 *   GET    /api/v1/models/:id/versions/:version/lineage           — lineage info
 *   GET    /api/v1/models/:id/versions/:version/metrics           — metrics only
 */
import {
  registerModel,
  createModelVersion,
  getModel,
  getModelVersion,
  listModels,
  listModelVersions,
  setModelStatus,
  deployModel,
  getDeployedModel,
  rollbackDeployment,
  getModelLineage,
  compareModels,
  searchModels,
  deleteModelVersion,
  getModelMetrics,
  generateModelCard,
} from "../lib/model-registry.js";

export function mountModelRegistryRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter, sanitizeWorkspace } = deps;
  const limiter = storageRateLimiter || ((_req, _res, next) => next());

  // GET /api/v1/models — list models
  apiRoute("get", "/models", limiter, async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId
        ? (sanitizeWorkspace ? sanitizeWorkspace(String(req.query.workspaceId)) : String(req.query.workspaceId))
        : null;
      const options = {
        tag: req.query?.tag ? String(req.query.tag) : undefined,
        type: req.query?.type ? String(req.query.type) : undefined,
        status: req.query?.status ? String(req.query.status) : undefined,
        limit: req.query?.limit ? Number(req.query.limit) : undefined,
        offset: req.query?.offset ? Number(req.query.offset) : undefined,
      };
      const result = await listModels(workspaceId, options);
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/models — register a new model
  apiRoute("post", "/models", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const workspaceId = body.workspaceId
        ? (sanitizeWorkspace ? sanitizeWorkspace(String(body.workspaceId)) : String(body.workspaceId))
        : "default";
      const userId = req.userId || "anonymous";
      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "name is required");
      }
      const doc = await registerModel(workspaceId, {
        name: body.name,
        baseModel: body.baseModel,
        type: body.type,
        description: body.description,
        tags: body.tags,
        path: body.path,
        remoteUrl: body.remoteUrl,
        createdBy: body.createdBy || userId,
      });
      res.status(201).json({ _version: 1, ...doc });
    } catch (err) {
      if (/required|invalid/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/models/search — search
  apiRoute("post", "/models/search", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const query = typeof body.query === "string" ? body.query : "";
      const filters = body.filters && typeof body.filters === "object" ? body.filters : {};
      const results = await searchModels(query, filters);
      res.json({ _version: 1, items: results, total: results.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/models/compare — compare two versions
  apiRoute("post", "/models/compare", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.a || !body.b) {
        return apiError(res, 400, "INVALID_INPUT", "both 'a' and 'b' are required with { modelId, version }");
      }
      const result = await compareModels(body.a, body.b);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required|invalid/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/deployments/:environment — current deployment
  apiRoute("get", "/models/deployments/:environment", limiter, async (req, res) => {
    try {
      const deployment = await getDeployedModel(req.params.environment);
      if (!deployment) {
        return apiError(res, 404, "NOT_FOUND", "no active deployment for this environment");
      }
      res.json({ _version: 1, ...deployment });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/models/deployments/rollback — roll back deployment
  apiRoute("post", "/models/deployments/rollback", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const environment = body.environment;
      const targetVersion = body.targetVersion;
      if (!environment || !targetVersion) {
        return apiError(res, 400, "INVALID_INPUT", "environment and targetVersion are required");
      }
      const deployment = await rollbackDeployment(environment, targetVersion);
      res.json({ _version: 1, ...deployment });
    } catch (err) {
      if (/not found|no current/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/invalid|required/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/:id — get model
  apiRoute("get", "/models/:id", limiter, async (req, res) => {
    try {
      const doc = await getModel(req.params.id);
      if (!doc) {
        return apiError(res, 404, "NOT_FOUND", "model not found");
      }
      res.json({ _version: 1, ...doc });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/:id/versions — list versions
  apiRoute("get", "/models/:id/versions", limiter, async (req, res) => {
    try {
      const doc = await getModel(req.params.id);
      if (!doc) {
        return apiError(res, 404, "NOT_FOUND", "model not found");
      }
      const versions = await listModelVersions(req.params.id);
      res.json({ _version: 1, modelId: doc.id, versions, total: versions.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/models/:id/versions — create version
  apiRoute("post", "/models/:id/versions", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const userId = req.userId || "anonymous";
      const record = await createModelVersion(req.params.id, {
        version: body.version,
        baseModel: body.baseModel,
        datasetId: body.datasetId,
        datasetVersion: body.datasetVersion,
        parentVersion: body.parentVersion,
        hyperparameters: body.hyperparameters,
        metrics: body.metrics,
        artifacts: body.artifacts,
        trainingTime: body.trainingTime,
        trainingCost: body.trainingCost,
        status: body.status,
        notes: body.notes,
        createdBy: body.createdBy || userId,
      });
      res.status(201).json({ _version: 1, ...record });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/required|invalid|already exists/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/:id/versions/:version
  apiRoute("get", "/models/:id/versions/:version", limiter, async (req, res) => {
    try {
      const v = await getModelVersion(req.params.id, req.params.version);
      if (!v) {
        return apiError(res, 404, "NOT_FOUND", "model version not found");
      }
      res.json({ _version: 1, ...v });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // PUT /api/v1/models/:id/versions/:version/status
  apiRoute("put", "/models/:id/versions/:version/status", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const status = body.status;
      if (!status) {
        return apiError(res, 400, "INVALID_INPUT", "status is required");
      }
      const v = await setModelStatus(req.params.id, req.params.version, status);
      res.json({ _version: 1, ...v });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/invalid|required/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // POST /api/v1/models/:id/versions/:version/deploy
  apiRoute("post", "/models/:id/versions/:version/deploy", limiter, async (req, res) => {
    try {
      const body = req.body || {};
      const environment = body.environment;
      if (!environment) {
        return apiError(res, 400, "INVALID_INPUT", "environment is required");
      }
      const deployment = await deployModel(req.params.id, req.params.version, environment);
      res.status(201).json({ _version: 1, ...deployment });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      if (/invalid|required/i.test(err.message)) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/:id/versions/:version/card — markdown model card
  apiRoute("get", "/models/:id/versions/:version/card", limiter, async (req, res) => {
    try {
      const doc = await getModel(req.params.id);
      if (!doc) {
        return apiError(res, 404, "NOT_FOUND", "model not found");
      }
      const v = doc.versions.find((x) => x.version === req.params.version);
      if (!v) {
        return apiError(res, 404, "NOT_FOUND", "model version not found");
      }
      const card = generateModelCard(doc, v);
      if (req.query?.format === "json") {
        return res.json({ _version: 1, modelId: doc.id, version: v.version, card });
      }
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.send(card);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/:id/versions/:version/lineage
  apiRoute("get", "/models/:id/versions/:version/lineage", limiter, async (req, res) => {
    try {
      const lineage = await getModelLineage(req.params.id, req.params.version);
      if (!lineage) {
        return apiError(res, 404, "NOT_FOUND", "model version not found");
      }
      res.json({ _version: 1, ...lineage });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // GET /api/v1/models/:id/versions/:version/metrics
  apiRoute("get", "/models/:id/versions/:version/metrics", limiter, async (req, res) => {
    try {
      const metrics = await getModelMetrics(req.params.id, req.params.version);
      if (metrics == null) {
        return apiError(res, 404, "NOT_FOUND", "model version not found");
      }
      res.json({ _version: 1, modelId: req.params.id, version: req.params.version, metrics });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });

  // DELETE /api/v1/models/:id/versions/:version
  apiRoute("delete", "/models/:id/versions/:version", limiter, async (req, res) => {
    try {
      const result = await deleteModelVersion(req.params.id, req.params.version);
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/not found/i.test(err.message)) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message, "See docs/RUNBOOK.md.");
    }
  });
}

export default mountModelRegistryRoutes;
