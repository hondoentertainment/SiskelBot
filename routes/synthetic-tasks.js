/**
 * Phase 56.3: Synthetic task generator routes.
 *
 * POST /api/v1/tasks/synthetic/generate     — generate a single task
 * POST /api/v1/tasks/synthetic/batch        — generate N tasks
 * POST /api/v1/tasks/synthetic/estimate     — estimate a task's difficulty
 * GET  /api/v1/tasks/synthetic/templates    — list known templates
 * POST /api/v1/tasks/synthetic/sets         — save a named task set
 * GET  /api/v1/tasks/synthetic/sets         — list saved sets
 * GET  /api/v1/tasks/synthetic/sets/:name   — fetch a saved set
 */

import {
  generateTask,
  generateBatch,
  estimateDifficulty,
  gradeByExpectedTime,
  listTemplates,
  validateTask,
  saveTaskSet,
  getTaskSet,
  listTaskSets,
  TASK_TEMPLATES,
} from "../lib/synthetic-tasks.js";

export function mountSyntheticTasksRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // GET /api/v1/tasks/synthetic/templates
  apiRoute("get", "/tasks/synthetic/templates", chatAuth, requireScope("read"), logRequest, (req, res) => {
    try {
      res.json({ templates: listTemplates() });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/tasks/synthetic/generate
  apiRoute("post", "/tasks/synthetic/generate", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const template = typeof body.template === "string" ? body.template : "";
      if (!template) {
        return apiError(res, 400, "INVALID_INPUT", "template is required.");
      }
      if (!TASK_TEMPLATES[template]) {
        return apiError(res, 404, "TEMPLATE_NOT_FOUND", `Unknown template '${template}'.`);
      }
      const difficulty = body.difficulty !== undefined ? body.difficulty : 3;
      const options = body.options && typeof body.options === "object" ? body.options : {};
      const task = await generateTask(template, difficulty, options);
      res.json({ task, expectedTimeMs: gradeByExpectedTime(task.difficulty) });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/tasks/synthetic/batch
  apiRoute("post", "/tasks/synthetic/batch", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const countRaw = Number(body.count);
      if (!Number.isFinite(countRaw) || countRaw < 0) {
        return apiError(res, 400, "INVALID_INPUT", "count must be a non-negative number.");
      }
      if (countRaw > 1000) {
        return apiError(res, 400, "INVALID_INPUT", "count must be <= 1000.");
      }
      const options = body.options && typeof body.options === "object" ? body.options : {};
      const tasks = await generateBatch(countRaw, options);
      res.json({ tasks, count: tasks.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/tasks/synthetic/estimate
  apiRoute("post", "/tasks/synthetic/estimate", chatAuth, requireScope("read"), logRequest, (req, res) => {
    try {
      const body = req.body || {};
      const task = body.task;
      if (!task || typeof task !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "task is required.");
      }
      const difficulty = estimateDifficulty(task);
      res.json({
        difficulty,
        expectedTimeMs: gradeByExpectedTime(difficulty),
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/tasks/synthetic/sets
  apiRoute("post", "/tasks/synthetic/sets", chatAuth, requireScope("write"), logRequest, async (req, res) => {
    try {
      const body = req.body || {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        return apiError(res, 400, "INVALID_INPUT", "name is required.");
      }
      if (!Array.isArray(body.tasks)) {
        return apiError(res, 400, "INVALID_INPUT", "tasks must be an array.");
      }
      for (const task of body.tasks) {
        const { ok, errors } = validateTask(task);
        if (!ok) {
          return apiError(res, 400, "INVALID_TASK", `invalid task: ${errors.join("; ")}`);
        }
      }
      const meta = {
        workspaceId: typeof body.workspaceId === "string" ? body.workspaceId : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
      };
      const saved = await saveTaskSet(name, body.tasks, meta);
      res.json({ set: { name: saved.name, taskCount: saved.tasks.length, savedAt: saved.savedAt } });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/tasks/synthetic/sets
  apiRoute("get", "/tasks/synthetic/sets", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const workspaceId = typeof req.query?.workspaceId === "string" ? req.query.workspaceId : null;
      const sets = await listTaskSets(workspaceId);
      res.json({ sets });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/tasks/synthetic/sets/:name
  apiRoute("get", "/tasks/synthetic/sets/:name", chatAuth, requireScope("read"), logRequest, async (req, res) => {
    try {
      const name = req.params.name;
      const set = await getTaskSet(name);
      if (!set) return apiError(res, 404, "SET_NOT_FOUND", `Task set '${name}' not found.`);
      res.json({ set });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountSyntheticTasksRoutes;
