/**
 * Zero to Hero learning curriculum routes.
 *
 * GET    /api/v1/learn/curriculum            — full curriculum
 * GET    /api/v1/learn/progress              — current user's progress
 * POST   /api/v1/learn/lessons/:id/start     — mark start / initialize
 * POST   /api/v1/learn/lessons/:id/complete  — mark lesson complete
 * GET    /api/v1/learn/lessons/:id           — lesson content with exercises
 * POST   /api/v1/learn/exercises/:id/submit  — submit exercise solution
 * GET    /api/v1/learn/badges                — earned + available badges
 * GET    /api/v1/learn/leaderboard           — workspace leaderboard
 */
import {
  CURRICULUM,
  BADGES,
  startCurriculum,
  getUserProgress,
  completeLesson,
  submitExercise,
  getLessonContent,
  getLeaderboard,
  getUserBadges,
} from "../lib/zero-to-hero.js";

export function mountZeroToHeroRoutes(app, deps) {
  const { apiRoute, apiError, sanitizeWorkspace } = deps;

  // GET /api/v1/learn/curriculum
  apiRoute("get", "/learn/curriculum", async (_req, res) => {
    try {
      res.json({ _version: 1, curriculum: CURRICULUM, badges: BADGES });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learn/progress
  apiRoute("get", "/learn/progress", async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const progress = await getUserProgress(userId);
      res.json({ _version: 1, ...progress });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/learn/lessons/:id/start
  apiRoute("post", "/learn/lessons/:id/start", async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const workspace = sanitizeWorkspace
        ? sanitizeWorkspace(req.body?.workspace)
        : req.body?.workspace || "default";
      const lessonId = req.params.id;
      const lesson = CURRICULUM.lessons.find((l) => l.id === lessonId);
      if (!lesson) {
        return apiError(res, 404, "NOT_FOUND", `Unknown lesson: ${lessonId}`);
      }
      const result = await startCurriculum(userId, workspace);
      res.json({ _version: 1, lessonId, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/learn/lessons/:id/complete
  apiRoute("post", "/learn/lessons/:id/complete", async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const lessonId = req.params.id;
      const lesson = CURRICULUM.lessons.find((l) => l.id === lessonId);
      if (!lesson) {
        return apiError(res, 404, "NOT_FOUND", `Unknown lesson: ${lessonId}`);
      }
      const result = await completeLesson(userId, lessonId, req.body || {});
      res.json({ _version: 1, ...result });
    } catch (err) {
      if (/Prerequisites not met/i.test(err.message)) {
        return apiError(res, 400, "PREREQUISITES_NOT_MET", err.message);
      }
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learn/lessons/:id
  apiRoute("get", "/learn/lessons/:id", async (req, res) => {
    try {
      const lessonId = req.params.id;
      const lesson = await getLessonContent(lessonId);
      if (!lesson) {
        return apiError(res, 404, "NOT_FOUND", `Unknown lesson: ${lessonId}`);
      }
      res.json({ _version: 1, lesson });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/learn/exercises/:id/submit
  apiRoute("post", "/learn/exercises/:id/submit", async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const exerciseId = req.params.id;
      const solution = req.body?.solution ?? req.body?.code;
      if (typeof solution !== "string" || !solution.trim()) {
        return apiError(res, 400, "INVALID_INPUT", "solution (string) is required");
      }
      const result = await submitExercise(userId, exerciseId, solution);
      res.json({ _version: 1, ...result });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learn/badges
  apiRoute("get", "/learn/badges", async (req, res) => {
    try {
      const userId = req.userId || "anonymous";
      const badges = await getUserBadges(userId);
      res.json({ _version: 1, ...badges });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/learn/leaderboard
  apiRoute("get", "/learn/leaderboard", async (req, res) => {
    try {
      const workspace = sanitizeWorkspace
        ? sanitizeWorkspace(req.query?.workspace)
        : req.query?.workspace || "default";
      const board = await getLeaderboard(workspace);
      res.json({ _version: 1, ...board });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });
}

export default mountZeroToHeroRoutes;
