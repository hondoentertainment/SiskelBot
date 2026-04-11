/**
 * Phase 56.3: Synthetic tasks routes.
 *
 * POST /api/v1/synthetic-tasks/generate      -- create a task set
 * GET  /api/v1/synthetic-tasks/sets          -- list task sets
 * GET  /api/v1/synthetic-tasks/sets/:id      -- fetch a task set
 * POST /api/v1/synthetic-tasks/:id/grade     -- grade a single task
 * POST /api/v1/synthetic-tasks/difficulty    -- sample a difficulty
 */
import {
  generateTaskSet,
  gradeTask,
  listTaskSets,
  getTaskSet,
  sampleDifficulty,
} from "../lib/synthetic-tasks.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "synthetic-tasks error");
}

export function mountSyntheticTasksRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/synthetic-tasks/generate", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      const set = await generateTaskSet({
        count: body.count,
        seed: body.seed,
        skills: body.skills,
        targetDifficulty: body.targetDifficulty,
        name: body.name,
      });
      return res.status(201).json({ _version: 1, taskSet: set });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/synthetic-tasks/sets", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listTaskSets();
      return res.json({ _version: 1, taskSets: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/synthetic-tasks/sets/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const set = await getTaskSet(req.params.id);
      if (!set) return apiError(res, 404, "NOT_FOUND", `task set "${req.params.id}" not found`);
      return res.json({ _version: 1, taskSet: set });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("post", "/synthetic-tasks/:id/grade", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (typeof body.response !== "string") {
        return apiError(res, 400, "INVALID_INPUT", "response string required");
      }
      const result = await gradeTask(req.params.id, body.response);
      return res.json({ _version: 1, result });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404
        : /required/i.test(err?.message || "") ? 400 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/synthetic-tasks/difficulty", log, auth, scope("read"), async (req, res) => {
    try {
      const body = req.body || {};
      const d = sampleDifficulty({ targetMean: body.targetMean });
      return res.json({ _version: 1, difficulty: d });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountSyntheticTasksRoutes;
