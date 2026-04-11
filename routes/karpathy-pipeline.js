/**
 * Karpathy 3-stage training pipeline routes.
 *
 *   GET    /api/v1/training/pipelines
 *   POST   /api/v1/training/pipelines
 *   GET    /api/v1/training/pipelines/:id
 *   POST   /api/v1/training/pipelines/:id/advance
 *   POST   /api/v1/training/pipelines/:id/prepare-data?stage=sft|pretrain|dpo
 *   POST   /api/v1/training/pipelines/:id/evaluate?stage=sft|pretrain|dpo
 */
import {
  STAGES,
  createTrainingPipeline,
  advanceStage,
  getPipelineStatus,
  listPipelines,
  preparePretrainingData,
  prepareSFTData,
  preparePreferenceData,
  evaluatePretraining,
  evaluateSFT,
  evaluatePreferenceAlignment,
} from "../lib/karpathy-pipeline.js";

export function mountKarpathyPipelineRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    sanitizeWorkspace,
    logRequest,
    userAuth,
    storageRateLimiter,
  } = deps;

  const limiter = storageRateLimiter || ((req, res, next) => next());
  const auth = userAuth || ((req, res, next) => next());
  const log = logRequest || ((req, res, next) => next());

  function resolveWorkspace(req) {
    const raw = req.body?.workspaceId || req.body?.workspace || req.query?.workspace;
    return typeof sanitizeWorkspace === "function" ? sanitizeWorkspace(raw) : (raw || "default");
  }

  apiRoute("get", "/training/pipelines", log, auth, limiter, async (req, res) => {
    try {
      const workspace = resolveWorkspace(req);
      const pipelines = await listPipelines(workspace);
      res.json({ _version: 1, workspace, pipelines });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "List pipelines failed");
    }
  });

  apiRoute("post", "/training/pipelines", log, auth, limiter, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "name required", "Provide a non-empty pipeline name");
      }
      const workspace = resolveWorkspace(req);
      const pipeline = await createTrainingPipeline({
        name: body.name,
        baseModel: body.baseModel,
        stages: body.stages,
        workspaceId: workspace,
        metadata: body.metadata,
      });
      res.status(201).json(pipeline);
    } catch (err) {
      return apiError(res, 400, "INVALID_INPUT", err?.message || "Create pipeline failed");
    }
  });

  apiRoute("get", "/training/pipelines/:id", log, auth, limiter, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_ID", "pipeline id required");
      const workspace = resolveWorkspace(req);
      const p = await getPipelineStatus(id, workspace);
      if (!p) return apiError(res, 404, "NOT_FOUND", "Pipeline not found", `No pipeline with id ${id}`);
      res.json(p);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Get pipeline failed");
    }
  });

  apiRoute("post", "/training/pipelines/:id/advance", log, auth, limiter, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_ID", "pipeline id required");
      const workspace = resolveWorkspace(req);
      const body = req.body || {};
      const stageResult = {
        outputModel: body.outputModel || null,
        metrics: body.metrics || null,
        notes: body.notes || "",
      };
      const updated = await advanceStage(id, stageResult, workspace);
      res.json(updated);
    } catch (err) {
      if (/not found/i.test(err?.message || "")) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Advance failed");
    }
  });

  apiRoute("post", "/training/pipelines/:id/prepare-data", log, auth, limiter, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_ID", "pipeline id required");
      const workspace = resolveWorkspace(req);
      const pipeline = await getPipelineStatus(id, workspace);
      if (!pipeline) return apiError(res, 404, "NOT_FOUND", "Pipeline not found");

      const stage = String(req.query?.stage || pipeline.currentStage || "").toLowerCase();
      const body = req.body || {};
      const options = (body.options && typeof body.options === "object") ? body.options : {};

      let result;
      if (stage === STAGES.PRETRAIN) {
        const docs = Array.isArray(body.documents) ? body.documents : [];
        result = await preparePretrainingData(docs, options);
      } else if (stage === STAGES.SFT) {
        const convs = Array.isArray(body.conversations) ? body.conversations : [];
        result = await prepareSFTData(convs, options);
      } else if (stage === STAGES.DPO || stage === STAGES.RLHF || stage === STAGES.REWARD_MODELING) {
        const convs = Array.isArray(body.conversations) ? body.conversations : [];
        result = await preparePreferenceData(convs, options);
      } else {
        return apiError(
          res,
          400,
          "INVALID_STAGE",
          `Unknown stage: ${stage}`,
          "Use pretrain, sft, reward_modeling, rlhf, or dpo"
        );
      }
      res.json({ pipelineId: id, stage, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Data preparation failed");
    }
  });

  apiRoute("post", "/training/pipelines/:id/evaluate", log, auth, limiter, async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!id) return apiError(res, 400, "INVALID_ID", "pipeline id required");
      const workspace = resolveWorkspace(req);
      const pipeline = await getPipelineStatus(id, workspace);
      if (!pipeline) return apiError(res, 404, "NOT_FOUND", "Pipeline not found");

      const stage = String(req.query?.stage || pipeline.currentStage || "").toLowerCase();
      const body = req.body || {};
      const testSet = Array.isArray(body.testSet) ? body.testSet : [];
      const preferencePairs = Array.isArray(body.preferencePairs) ? body.preferencePairs : [];
      // model is provided as a descriptor; the actual scoring functions live
      // on the caller side. Here we pass through any labeled metrics on the
      // test set items (see lib/karpathy-pipeline.js for details).
      const model = body.model || null;

      let result;
      if (stage === STAGES.PRETRAIN) {
        result = await evaluatePretraining(model, testSet);
      } else if (stage === STAGES.SFT) {
        result = await evaluateSFT(model, testSet);
      } else if (stage === STAGES.DPO || stage === STAGES.RLHF || stage === STAGES.REWARD_MODELING) {
        result = await evaluatePreferenceAlignment(model, preferencePairs);
      } else {
        return apiError(
          res,
          400,
          "INVALID_STAGE",
          `Unknown stage: ${stage}`,
          "Use pretrain, sft, reward_modeling, rlhf, or dpo"
        );
      }
      res.json({ pipelineId: id, stage, metrics: result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "Evaluation failed");
    }
  });
}

export default mountKarpathyPipelineRoutes;
