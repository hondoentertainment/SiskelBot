/**
 * Phase 21: Workflow engine API routes.
 * Provides CRUD for workflows and execution/run history endpoints.
 */
import { Router } from "express";
import { requireFeature } from "../lib/entitlements.js";
import {
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listWorkflows,
  getWorkflow,
  executeWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
} from "../lib/workflow-engine.js";

export default function workflowRoutes({ apiError, storageRateLimiter, requireScope, logRequest }) {
  const router = Router();

  router.get("/", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || "default";
      const items = await listWorkflows(workspace);
      res.json({ ok: true, workflows: items });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || "default";
      const body = req.body || {};
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "Workflow name is required");
      const workflow = await createWorkflow(workspace, body);
      res.status(201).json({ ok: true, workflow });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/runs/:runId", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || "default";
      const run = await getWorkflowRun(req.params.runId, workspace);
      if (!run) return apiError(res, 404, "NOT_FOUND", "Workflow run not found");
      res.json({ ok: true, run });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/:id", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || "default";
      const workflow = await getWorkflow(req.params.id, workspace);
      if (!workflow) return apiError(res, 404, "NOT_FOUND", "Workflow not found");
      res.json({ ok: true, workflow });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  router.put("/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const updated = await updateWorkflow(req.params.id, req.body || {});
      if (!updated) return apiError(res, 404, "NOT_FOUND", "Workflow not found");
      res.json({ ok: true, workflow: updated });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  router.delete("/:id", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const deleted = await deleteWorkflow(req.params.id);
      if (!deleted) return apiError(res, 404, "NOT_FOUND", "Workflow not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  router.post("/:id/run", storageRateLimiter, requireScope("write"), logRequest, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || "default";
      const body = req.body || {};
      const run = await executeWorkflow(req.params.id, {
        variables: body.variables || {},
        triggeredBy: body.triggeredBy || "manual",
        input: body.input || {},
        workspaceId: workspace,
      });
      res.json({ ok: true, run });
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.message.includes("disabled")) return apiError(res, 400, "WORKFLOW_DISABLED", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  router.get("/:id/runs", storageRateLimiter, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || "default";
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;
      const runs = await listWorkflowRuns(req.params.id, { workspaceId: workspace, limit, offset });
      res.json({ ok: true, runs });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  return router;
}

function deprecationWorkflow(req, res, next) {
  res.setHeader("X-API-Deprecated", "use /api/v1/");
  res.setHeader("Sunset", "2027-01-01T00:00:00Z");
  res.setHeader("Deprecation", "true");
  next();
}

export function mountWorkflowRoutes(app, deps) {
  const router = workflowRoutes({
    apiError: deps.apiError,
    storageRateLimiter: deps.storageRateLimiter,
    requireScope: deps.requireScope,
    logRequest: deps.logRequest,
  });
  // Workflows are a Pro feature. The gate is a no-op unless
  // ENFORCE_PLAN_LIMITS=1 and fails open on any error.
  const featureGate = requireFeature("workflows", { apiError: deps.apiError });
  app.use("/api/v1/workflows", featureGate, router);
  app.use("/api/workflows", deprecationWorkflow, featureGate, router);
}
