/**
 * Route module: curriculum scheduler (Phase 56.4).
 *
 * POST   /api/v1/curriculum                       — create curriculum
 * GET    /api/v1/curriculum/:name                 — get curriculum
 * GET    /api/v1/curricula                        — list curricula
 * DELETE /api/v1/curriculum/:name                 — delete curriculum
 * POST   /api/v1/curriculum/:name/step            — record a step
 * GET    /api/v1/curriculum/:name/history         — get history
 * GET    /api/v1/curriculum/:name/next            — next difficulty
 * POST   /api/v1/curriculum/:name/recommend       — recommend task from pool
 * GET    /api/v1/curriculum/:name/report          — progress report
 * GET    /api/v1/curriculum/:name/plateau         — plateau detection
 */
import {
  createCurriculum,
  getCurriculum,
  listCurricula,
  deleteCurriculum,
  recordCurriculumStep,
  getCurriculumHistory,
  CurriculumScheduler,
  recommendNextTask,
  generateProgressReport,
  detectPlateau,
} from "../lib/curriculum.js";

export function mountCurriculumRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, chatAuth, requireScope } = deps;

  // POST /api/v1/curriculum
  apiRoute(
    "post",
    "/curriculum",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const { name } = body;
        if (!name || typeof name !== "string") {
          return apiError(res, 400, "INVALID_INPUT", "name is required.");
        }
        const record = await createCurriculum(name, {
          targetSuccessRate: body.targetSuccessRate,
          difficultyStepSize: body.difficultyStepSize,
          minDifficulty: body.minDifficulty,
          maxDifficulty: body.maxDifficulty,
          skillEstimator: body.skillEstimator,
        });
        res.status(201).json(record);
      } catch (err) {
        if (err?.code === "ALREADY_EXISTS") {
          return apiError(res, 409, "ALREADY_EXISTS", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/curricula
  apiRoute(
    "get",
    "/curricula",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const records = await listCurricula();
        res.json({ curricula: records });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/curriculum/:name
  apiRoute(
    "get",
    "/curriculum/:name",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const rec = await getCurriculum(req.params.name);
        if (!rec) {
          return apiError(res, 404, "NOT_FOUND", `curriculum ${req.params.name} not found`);
        }
        res.json(rec);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // DELETE /api/v1/curriculum/:name
  apiRoute(
    "delete",
    "/curriculum/:name",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const result = await deleteCurriculum(req.params.name);
        if (!result.ok) {
          return apiError(res, 404, "NOT_FOUND", `curriculum ${req.params.name} not found`);
        }
        res.json(result);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/curriculum/:name/step
  apiRoute(
    "post",
    "/curriculum/:name/step",
    chatAuth,
    requireScope("write"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const { taskId, difficulty, success, durationMs } = body;
        if (typeof difficulty !== "number") {
          return apiError(res, 400, "INVALID_INPUT", "difficulty must be a number.");
        }
        if (typeof success !== "boolean") {
          return apiError(res, 400, "INVALID_INPUT", "success must be a boolean.");
        }
        const result = await recordCurriculumStep(req.params.name, {
          taskId,
          difficulty,
          success,
          durationMs,
        });
        res.status(201).json(result);
      } catch (err) {
        if (err?.code === "NOT_FOUND") {
          return apiError(res, 404, "NOT_FOUND", err.message);
        }
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/curriculum/:name/history
  apiRoute(
    "get",
    "/curriculum/:name/history",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const history = await getCurriculumHistory(req.params.name);
        if (history === null) {
          return apiError(res, 404, "NOT_FOUND", `curriculum ${req.params.name} not found`);
        }
        res.json({ name: req.params.name, history });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/curriculum/:name/next
  apiRoute(
    "get",
    "/curriculum/:name/next",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const rec = await getCurriculum(req.params.name);
        if (!rec) {
          return apiError(res, 404, "NOT_FOUND", `curriculum ${req.params.name} not found`);
        }
        const scheduler = CurriculumScheduler.fromJSON(rec);
        res.json({
          name: rec.name,
          nextDifficulty: scheduler.nextDifficulty(),
          currentSkill: scheduler.skillEstimator.getSkill(),
          targetSuccessRate: scheduler.targetSuccessRate,
        });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // POST /api/v1/curriculum/:name/recommend
  apiRoute(
    "post",
    "/curriculum/:name/recommend",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const body = req.body || {};
        const { tasks } = body;
        if (!Array.isArray(tasks)) {
          return apiError(res, 400, "INVALID_INPUT", "tasks must be an array.");
        }
        const rec = await getCurriculum(req.params.name);
        if (!rec) {
          return apiError(res, 404, "NOT_FOUND", `curriculum ${req.params.name} not found`);
        }
        const scheduler = CurriculumScheduler.fromJSON(rec);
        const result = recommendNextTask(tasks, scheduler);
        res.json(result || { task: null });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/curriculum/:name/report
  apiRoute(
    "get",
    "/curriculum/:name/report",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const report = await generateProgressReport(req.params.name);
        if (!report) {
          return apiError(res, 404, "NOT_FOUND", `curriculum ${req.params.name} not found`);
        }
        res.json(report);
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );

  // GET /api/v1/curriculum/:name/plateau
  apiRoute(
    "get",
    "/curriculum/:name/plateau",
    chatAuth,
    requireScope("read"),
    logRequest,
    async (req, res) => {
      try {
        const history = await getCurriculumHistory(req.params.name);
        if (history === null) {
          return apiError(res, 404, "NOT_FOUND", `curriculum ${req.params.name} not found`);
        }
        const windowSize = Number(req.query?.windowSize) || 10;
        const result = detectPlateau(history, windowSize);
        res.json({ name: req.params.name, ...result });
      } catch (err) {
        return apiError(res, 500, "INTERNAL_ERROR", err.message);
      }
    },
  );
}

export default mountCurriculumRoutes;
