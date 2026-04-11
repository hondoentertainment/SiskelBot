/**
 * Phase 54.1: Video understanding routes.
 *
 * POST /api/v1/video/sample         — body: { video, options }
 * POST /api/v1/video/analyze        — body: { video, options }
 * POST /api/v1/video/summary        — body: { analyses }
 * POST /api/v1/video/scenes         — body: { frames, options }
 * POST /api/v1/video/motion         — body: { frames }
 * GET  /api/v1/video/analysis/:id
 * GET  /api/v1/video/analyses
 */
import {
  sampleFrames,
  analyzeVideo,
  generateVideoSummary,
  detectSceneChanges,
  detectMotion,
  getVideoAnalysis,
  listVideoAnalyses,
  saveVideoAnalysis,
} from "../lib/video-understanding.js";

function sendError(apiError, res, err) {
  const msg = err?.message || "video-understanding error";
  const status = /required|must be|invalid|unknown/i.test(msg) ? 400 : 500;
  const code = status === 400 ? "INVALID_INPUT" : "INTERNAL_ERROR";
  return apiError(res, status, code, msg);
}

export function mountVideoUnderstandingRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // POST /api/v1/video/sample
  apiRoute("post", "/video/sample", log, auth, scope("read"), async (req, res) => {
    try {
      const { video, options } = req.body || {};
      if (!video) {
        return apiError(res, 400, "INVALID_INPUT", "video is required");
      }
      const frames = await sampleFrames(video, options || {});
      return res.json({ _version: 1, frames, count: frames.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/video/analyze
  apiRoute("post", "/video/analyze", log, auth, scope("read"), async (req, res) => {
    try {
      const { video, options } = req.body || {};
      if (!video) {
        return apiError(res, 400, "INVALID_INPUT", "video is required");
      }
      const analysis = await analyzeVideo(video, options || {});
      if (req.body?.videoId) {
        await saveVideoAnalysis(req.body.videoId, analysis, {
          workspaceId: req.body.workspaceId,
          userId: req.body.userId,
        });
      }
      return res.json({ _version: 1, analysis });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/video/summary
  apiRoute("post", "/video/summary", log, auth, scope("read"), async (req, res) => {
    try {
      const { analyses } = req.body || {};
      if (!analyses || typeof analyses !== "object") {
        return apiError(res, 400, "INVALID_INPUT", "analyses is required");
      }
      const summary = await generateVideoSummary(analyses);
      return res.json({ _version: 1, summary });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/video/scenes
  apiRoute("post", "/video/scenes", log, auth, scope("read"), async (req, res) => {
    try {
      const { frames, options } = req.body || {};
      if (!Array.isArray(frames)) {
        return apiError(res, 400, "INVALID_INPUT", "frames must be an array");
      }
      const scenes = detectSceneChanges(frames, options || {});
      return res.json({ _version: 1, scenes, count: scenes.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // POST /api/v1/video/motion
  apiRoute("post", "/video/motion", log, auth, scope("read"), async (req, res) => {
    try {
      const { frames } = req.body || {};
      if (!Array.isArray(frames)) {
        return apiError(res, 400, "INVALID_INPUT", "frames must be an array");
      }
      const motion = detectMotion(frames);
      return res.json({ _version: 1, motion, count: motion.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/video/analysis/:id
  apiRoute("get", "/video/analysis/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const entry = await getVideoAnalysis(req.params.id);
      if (!entry) {
        return apiError(res, 404, "NOT_FOUND", `analysis ${req.params.id} not found`);
      }
      return res.json({ _version: 1, entry });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });

  // GET /api/v1/video/analyses
  apiRoute("get", "/video/analyses", log, auth, scope("read"), async (req, res) => {
    try {
      const workspaceId = req.query?.workspaceId;
      const items = await listVideoAnalyses(workspaceId);
      return res.json({ _version: 1, items, count: items.length });
    } catch (err) {
      return sendError(apiError, res, err);
    }
  });
}

export default mountVideoUnderstandingRoutes;
