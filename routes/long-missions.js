/**
 * Phase 47.5: Long-running missions routes.
 *
 * GET    /api/v1/missions                          — list missions
 * POST   /api/v1/missions                          — create mission
 * GET    /api/v1/missions/:id                      — get mission
 * POST   /api/v1/missions/:id/start                — start mission
 * POST   /api/v1/missions/:id/pause                — pause mission
 * POST   /api/v1/missions/:id/resume               — resume mission
 * POST   /api/v1/missions/:id/abort                — abort mission
 * GET    /api/v1/missions/:id/checkpoints          — list checkpoints
 * POST   /api/v1/missions/:id/checkpoints          — manual checkpoint
 * POST   /api/v1/missions/:id/restore/:checkpointId — restore from checkpoint
 * GET    /api/v1/missions/:id/status               — get status (with elapsed/remaining)
 * GET    /api/v1/missions/:id/history              — event history
 * DELETE /api/v1/missions/:id                      — delete mission
 */
import {
  createMission,
  listMissions,
  getMission,
  startMission,
  pauseMission,
  resumeMission,
  abortMission,
  createCheckpoint,
  listCheckpoints,
  restoreFromCheckpoint,
  getMissionStatus,
  getMissionHistory,
  deleteMission,
} from "../lib/long-running-missions.js";

export function mountLongMissionRoutes(app, deps) {
  const { apiRoute, apiError, storageRateLimiter } = deps;
  const limiter = storageRateLimiter || ((req, res, next) => next());

  // GET /api/v1/missions
  apiRoute("get", "/missions", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const status = req.query?.status;
      const missions = await listMissions(workspace, status);
      res.json({ ok: true, missions });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/missions — create
  apiRoute("post", "/missions", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.body?.workspaceId || "default";
      const body = req.body || {};
      if (!body.name) return apiError(res, 400, "INVALID_INPUT", "name is required");
      if (!body.goal) return apiError(res, 400, "INVALID_INPUT", "goal is required");

      const result = await createMission({
        workspaceId: workspace,
        name: body.name,
        goal: body.goal,
        maxDurationHours: body.maxDurationHours,
        checkpointIntervalMs: body.checkpointIntervalMs,
        agentConfig: body.agentConfig,
        notifyOnComplete: body.notifyOnComplete,
        constraints: body.constraints,
      });
      res.status(201).json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("required") || err.message.includes("Maximum")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/missions/:id
  apiRoute("get", "/missions/:id", limiter, async (req, res) => {
    try {
      const mission = await getMission(req.params.id);
      if (!mission) return apiError(res, 404, "NOT_FOUND", "Mission not found");
      res.json({ ok: true, mission });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/missions/:id/start
  apiRoute("post", "/missions/:id/start", limiter, async (req, res) => {
    try {
      const result = await startMission(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.message.includes("Cannot start")) return apiError(res, 409, "INVALID_STATE", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/missions/:id/pause
  apiRoute("post", "/missions/:id/pause", limiter, async (req, res) => {
    try {
      const reason = req.body?.reason || "manual";
      const result = await pauseMission(req.params.id, reason);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.message.includes("Cannot pause")) return apiError(res, 409, "INVALID_STATE", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/missions/:id/resume
  apiRoute("post", "/missions/:id/resume", limiter, async (req, res) => {
    try {
      const result = await resumeMission(req.params.id);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.message.includes("Cannot resume")) return apiError(res, 409, "INVALID_STATE", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/missions/:id/abort
  apiRoute("post", "/missions/:id/abort", limiter, async (req, res) => {
    try {
      const reason = req.body?.reason || "manual";
      const result = await abortMission(req.params.id, reason);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/missions/:id/checkpoints
  apiRoute("get", "/missions/:id/checkpoints", limiter, async (req, res) => {
    try {
      const checkpoints = await listCheckpoints(req.params.id);
      res.json({ ok: true, checkpoints });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/missions/:id/checkpoints — manual checkpoint
  apiRoute("post", "/missions/:id/checkpoints", limiter, async (req, res) => {
    try {
      const checkpoint = await createCheckpoint(req.params.id);
      res.status(201).json({ ok: true, checkpoint });
    } catch (err) {
      if (err.message.includes("not found")) return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/missions/:id/restore/:checkpointId
  apiRoute("post", "/missions/:id/restore/:checkpointId", limiter, async (req, res) => {
    try {
      const result = await restoreFromCheckpoint(req.params.id, req.params.checkpointId);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.message.includes("not found") || err.message.includes("Invalid")) {
        return apiError(res, 404, "NOT_FOUND", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/missions/:id/status
  apiRoute("get", "/missions/:id/status", limiter, async (req, res) => {
    try {
      const status = await getMissionStatus(req.params.id);
      if (!status) return apiError(res, 404, "NOT_FOUND", "Mission not found");
      res.json({ ok: true, status });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/missions/:id/history
  apiRoute("get", "/missions/:id/history", limiter, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query?.limit) || 100, 1000);
      const events = await getMissionHistory(req.params.id, limit);
      res.json({ ok: true, events });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/missions/:id
  apiRoute("delete", "/missions/:id", limiter, async (req, res) => {
    try {
      const workspace = req.headers["x-workspace-id"] || req.query?.workspace || "default";
      const deleted = await deleteMission(workspace, req.params.id);
      if (!deleted) return apiError(res, 404, "NOT_FOUND", "Mission not found");
      res.json({ ok: true, deleted: true });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountLongMissionRoutes;
