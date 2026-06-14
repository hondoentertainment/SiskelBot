/**
 * Route module: tool discovery endpoints (Phase 32.3).
 *
 * Exposes the learned effectiveness of agent tools so clients can inspect
 * which tools work best for particular task types.
 *
 * GET /api/v1/tools/stats                       -- all tool stats
 * GET /api/v1/tools/ranking                     -- global ranking
 * GET /api/v1/tools/recommend?task=...          -- recommendations for a task
 * GET /api/v1/tools/effectiveness?taskType=...  -- ranking for a task type
 * GET /api/v1/tools/:name/stats                 -- single tool stats
 */
import { globalToolDiscovery } from "../lib/tool-discovery.js";

export function mountToolDiscoveryRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  apiRoute("get", "/tools/stats", logRequest, (req, res) => {
    try {
      const stats = globalToolDiscovery.getAllStats();
      res.json({ tools: stats, count: Object.keys(stats).length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/tools/ranking", logRequest, (req, res) => {
    try {
      const ranking = globalToolDiscovery.getGlobalRanking();
      res.json({ ranking, count: ranking.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/tools/recommend", logRequest, (req, res) => {
    try {
      const task = typeof req.query?.task === "string" ? req.query.task.trim() : "";
      if (!task) {
        return apiError(res, 400, "INVALID_ARGUMENT", "task query parameter is required");
      }
      const recommendations = globalToolDiscovery.recommendToolsForTask(task);
      res.json({ task, recommendations, count: recommendations.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/tools/effectiveness", logRequest, (req, res) => {
    try {
      const taskType = typeof req.query?.taskType === "string" ? req.query.taskType.trim() : "";
      if (!taskType) {
        return apiError(res, 400, "INVALID_ARGUMENT", "taskType query parameter is required");
      }
      const rows = globalToolDiscovery.getToolEffectivenessByTask(taskType);
      res.json({ taskType, tools: rows, count: rows.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  apiRoute("get", "/tools/:name/stats", logRequest, (req, res) => {
    try {
      const name = req.params.name;
      const stats = globalToolDiscovery.getToolStats(name);
      if (!stats) {
        return apiError(res, 404, "NOT_FOUND", `No usage data for tool "${name}"`);
      }
      res.json(stats);
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountToolDiscoveryRoutes;
