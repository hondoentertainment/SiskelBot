/**
 * Phase 56.4: Curriculum scheduler routes.
 *
 * POST /api/v1/curricula                       -- create curriculum
 * GET  /api/v1/curricula                       -- list curricula
 * GET  /api/v1/curricula/:id/next/:agentId     -- next task
 * POST /api/v1/curricula/:id/results/:agentId  -- record result
 * GET  /api/v1/curricula/:id/skill/:agentId    -- skill level
 * PATCH /api/v1/curricula/:id/adjust           -- adjust difficulty
 */
import {
  createCurriculum,
  nextTask,
  recordResult,
  getSkillLevel,
  adjustDifficulty,
  listCurricula,
} from "../lib/curriculum-scheduler.js";

function sendError(apiError, res, err, status = 500) {
  const code = status === 400 ? "INVALID_INPUT" : status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR";
  return apiError(res, status, code, err?.message || "curriculum error");
}

export function mountCurriculumSchedulerRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  apiRoute("post", "/curricula", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.tasks)) {
        return apiError(res, 400, "INVALID_INPUT", "tasks array required");
      }
      const cur = await createCurriculum({
        name: body.name,
        tasks: body.tasks,
        initialSkill: body.initialSkill,
        bandWidth: body.bandWidth,
        window: body.window,
      });
      return res.status(201).json({ _version: 1, curriculum: cur });
    } catch (err) {
      return sendError(apiError, res, err, 400);
    }
  });

  apiRoute("get", "/curricula", log, auth, scope("read"), async (_req, res) => {
    try {
      const list = await listCurricula();
      return res.json({ _version: 1, curricula: list, count: list.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  apiRoute("get", "/curricula/:id/next/:agentId", log, auth, scope("read"), async (req, res) => {
    try {
      const task = await nextTask(req.params.id, req.params.agentId);
      if (!task) return apiError(res, 404, "NOT_FOUND", "no task available");
      return res.json({ _version: 1, task });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("post", "/curricula/:id/results/:agentId", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.taskId) {
        return apiError(res, 400, "INVALID_INPUT", "taskId required");
      }
      const out = await recordResult(req.params.id, req.params.agentId, {
        taskId: body.taskId,
        correct: !!body.correct,
      });
      return res.json({ _version: 1, result: out });
    } catch (err) {
      const status = /not found|not in curriculum/i.test(err?.message || "") ? 404
        : /required/i.test(err?.message || "") ? 400 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("get", "/curricula/:id/skill/:agentId", log, auth, scope("read"), async (req, res) => {
    try {
      const skill = await getSkillLevel(req.params.id, req.params.agentId);
      return res.json({ _version: 1, skill });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });

  apiRoute("patch", "/curricula/:id/adjust", log, auth, scope("write"), async (req, res) => {
    try {
      const body = req.body || {};
      if (!Number.isFinite(body.delta)) {
        return apiError(res, 400, "INVALID_INPUT", "numeric delta required");
      }
      const out = await adjustDifficulty(req.params.id, body.delta, {
        applyToAgents: !!body.applyToAgents,
      });
      return res.json({ _version: 1, adjustment: out });
    } catch (err) {
      const status = /not found/i.test(err?.message || "") ? 404 : 500;
      return sendError(apiError, res, err, status);
    }
  });
}

export default mountCurriculumSchedulerRoutes;
