/**
 * Route module: canary deployments (Phase 59.4).
 *
 * POST   /api/v1/canary/deployments                     — create
 * GET    /api/v1/canary/deployments                     — list
 * GET    /api/v1/canary/deployments/:id                 — get
 * DELETE /api/v1/canary/deployments/:id                 — delete
 * POST   /api/v1/canary/deployments/:id/start           — start rollout
 * POST   /api/v1/canary/deployments/:id/pause           — pause
 * POST   /api/v1/canary/deployments/:id/resume          — resume
 * POST   /api/v1/canary/deployments/:id/abort           — abort (body.reason)
 * POST   /api/v1/canary/deployments/:id/advance         — manual advance
 * POST   /api/v1/canary/deployments/:id/rollback        — revert to 100% A
 * POST   /api/v1/canary/deployments/:id/health          — submit health sample
 * GET    /api/v1/canary/deployments/:id/health          — aggregated health summary
 * GET    /api/v1/canary/deployments/:id/history         — event history
 * GET    /api/v1/canary/deployments/:id/compare         — side-by-side A vs B
 * POST   /api/v1/canary/deployments/:id/route           — routing decision for a key
 *
 * All routes require an admin-scoped API key.
 */
import {
  createDeployment,
  getDeployment,
  listDeployments,
  deleteDeployment,
  startDeployment,
  pauseDeployment,
  resumeDeployment,
  abortDeployment,
  advancePhase,
  rollbackDeployment,
  recordHealthSample,
  getHealthSummary,
  getDeploymentHistory,
  compareVersions,
  routeTraffic,
} from "../lib/canary.js";

function mapErr(err) {
  if (err?.code === "NOT_FOUND") return { status: 404, code: "NOT_FOUND" };
  if (err?.code === "INVALID_STATE") return { status: 409, code: "INVALID_STATE" };
  if (err?.code === "ALREADY_EXISTS") return { status: 409, code: "ALREADY_EXISTS" };
  if (/required/i.test(err?.message || "") || /must be/i.test(err?.message || "")) {
    return { status: 400, code: "INVALID_INPUT" };
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

export function mountCanaryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, adminAuth } = deps;

  // POST /api/v1/canary/deployments
  apiRoute("post", "/canary/deployments", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const dep = await createDeployment({
        name: body.name,
        versionA: body.versionA,
        versionB: body.versionB,
        phases: body.phases,
        healthChecks: body.healthChecks,
      });
      res.status(201).json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/canary/deployments
  apiRoute("get", "/canary/deployments", adminAuth, logRequest, async (req, res) => {
    try {
      const filter = {};
      if (req.query?.status) filter.status = String(req.query.status);
      if (req.query?.name) filter.name = String(req.query.name);
      const deployments = await listDeployments(filter);
      res.json({ deployments });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/canary/deployments/:id
  apiRoute("get", "/canary/deployments/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const dep = await getDeployment(req.params.id);
      if (!dep) return apiError(res, 404, "NOT_FOUND", "deployment not found");
      res.json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // DELETE /api/v1/canary/deployments/:id
  apiRoute("delete", "/canary/deployments/:id", adminAuth, logRequest, async (req, res) => {
    try {
      const result = await deleteDeployment(req.params.id);
      if (!result.ok) return apiError(res, 404, "NOT_FOUND", "deployment not found");
      res.json({ deleted: true, id: req.params.id });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/start
  apiRoute("post", "/canary/deployments/:id/start", adminAuth, logRequest, async (req, res) => {
    try {
      const dep = await startDeployment(req.params.id);
      res.json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/pause
  apiRoute("post", "/canary/deployments/:id/pause", adminAuth, logRequest, async (req, res) => {
    try {
      const dep = await pauseDeployment(req.params.id);
      res.json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/resume
  apiRoute("post", "/canary/deployments/:id/resume", adminAuth, logRequest, async (req, res) => {
    try {
      const dep = await resumeDeployment(req.params.id);
      res.json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/abort
  apiRoute("post", "/canary/deployments/:id/abort", adminAuth, logRequest, async (req, res) => {
    try {
      const reason = req.body?.reason;
      const dep = await abortDeployment(req.params.id, reason);
      res.json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/advance
  apiRoute("post", "/canary/deployments/:id/advance", adminAuth, logRequest, async (req, res) => {
    try {
      const dep = await advancePhase(req.params.id);
      res.json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/rollback
  apiRoute("post", "/canary/deployments/:id/rollback", adminAuth, logRequest, async (req, res) => {
    try {
      const dep = await rollbackDeployment(req.params.id);
      res.json(dep);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/health
  apiRoute("post", "/canary/deployments/:id/health", adminAuth, logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const version = body.version;
      if (version !== "A" && version !== "B") {
        return apiError(res, 400, "INVALID_INPUT", "version must be 'A' or 'B'");
      }
      await recordHealthSample(req.params.id, version, body.sample || body);
      res.json({ ok: true });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/canary/deployments/:id/health
  apiRoute("get", "/canary/deployments/:id/health", adminAuth, logRequest, async (req, res) => {
    try {
      const summary = await getHealthSummary(req.params.id);
      res.json(summary);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/canary/deployments/:id/history
  apiRoute("get", "/canary/deployments/:id/history", adminAuth, logRequest, async (req, res) => {
    try {
      const history = await getDeploymentHistory(req.params.id);
      res.json({ history });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // GET /api/v1/canary/deployments/:id/compare
  apiRoute("get", "/canary/deployments/:id/compare", adminAuth, logRequest, async (req, res) => {
    try {
      const dep = await getDeployment(req.params.id);
      if (!dep) return apiError(res, 404, "NOT_FOUND", "deployment not found");
      const comparison = compareVersions(dep);
      res.json(comparison);
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });

  // POST /api/v1/canary/deployments/:id/route
  apiRoute("post", "/canary/deployments/:id/route", adminAuth, logRequest, async (req, res) => {
    try {
      const { requestKey } = req.body || {};
      if (!requestKey || typeof requestKey !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "requestKey string is required");
      }
      const dep = await getDeployment(req.params.id);
      if (!dep) return apiError(res, 404, "NOT_FOUND", "deployment not found");
      const version = routeTraffic(dep, requestKey);
      res.json({
        deploymentId: dep.id,
        requestKey,
        version,
        percentage: dep.currentPercentage,
        status: dep.status,
        target: version === "B" ? dep.versionB : dep.versionA,
      });
    } catch (err) {
      const { status, code } = mapErr(err);
      return apiError(res, status, code, err.message);
    }
  });
}

export default mountCanaryRoutes;
