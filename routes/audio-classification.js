/**
 * Phase 54.3: Audio beyond STT — classification routes.
 *
 * POST /api/v1/audio/classify/music    — body: { audio, sampleRate? }
 * POST /api/v1/audio/classify/events   — body: { audio, sampleRate? }
 * POST /api/v1/audio/classify/emotion  — body: { audio, sampleRate? }
 * POST /api/v1/audio/classify/acoustic — body: { audio, sampleRate? }
 * POST /api/v1/audio/analyze           — body: { audio, audioId?, domains?, sampleRate?, save? }
 * POST /api/v1/audio/segments          — body: { audio, segmentMs?, sampleRate? }
 * GET  /api/v1/audio/analysis/:id      — fetch a saved analysis by audioId
 * GET  /api/v1/audio/analyses          — list saved analyses (query filters)
 * GET  /api/v1/audio/categories        — enumerate supported categories
 *
 * The `audio` field accepts either a base64 string or an array of byte values.
 * No new dependencies are introduced; this route leans on lib/audio-classification.js.
 */
import {
  CATEGORIES,
  classifyMusic,
  classifyEvents,
  classifyEmotion,
  classifyAcoustic,
  analyzeAudio,
  analyzeSegments,
  saveAnalysis,
  getAnalysis,
  listAnalyses,
} from "../lib/audio-classification.js";

function decodeAudio(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    try {
      return Buffer.from(value);
    } catch {
      return null;
    }
  }
  if (typeof value === "string") {
    // Try base64 first, fall back to utf8.
    try {
      const decoded = Buffer.from(value, "base64");
      if (decoded.length > 0) return decoded;
    } catch {
      /* ignore */
    }
    return Buffer.from(value, "utf8");
  }
  if (typeof value === "object" && value.data) {
    return decodeAudio(value.data);
  }
  return null;
}

function extractAudio(req) {
  const body = req.body || {};
  return decodeAudio(body.audio ?? body.data ?? body.buffer);
}

function parseSampleRate(body) {
  const raw = body?.sampleRate;
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function wrapClassify(fn, errorCode) {
  return async (req, res, apiError) => {
    try {
      const audio = extractAudio(req);
      if (!audio || audio.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "audio is required");
      }
      const options = { sampleRate: parseSampleRate(req.body) };
      const result = await fn(audio, options);
      return res.json({ _version: 1, result });
    } catch (err) {
      if (/invalid domain/i.test(err?.message || "")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, errorCode, err?.message || "classification failed");
    }
  };
}

export function mountAudioClassificationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest, userAuth, requireScope } = deps;

  const noopAuth = (_req, _res, next) => next();
  const noopScope = (_scope) => (_req, _res, next) => next();
  const log = typeof logRequest === "function" ? logRequest : (_req, _res, next) => next();
  const auth = typeof userAuth === "function" ? userAuth : noopAuth;
  const scope = typeof requireScope === "function" ? requireScope : noopScope;

  // GET /api/v1/audio/categories
  apiRoute("get", "/audio/categories", log, auth, scope("read"), async (_req, res) => {
    return res.json({ _version: 1, categories: CATEGORIES });
  });

  // POST /api/v1/audio/classify/music
  apiRoute("post", "/audio/classify/music", log, auth, scope("write"), async (req, res) => {
    return wrapClassify(classifyMusic, "CLASSIFY_FAILED")(req, res, apiError);
  });

  // POST /api/v1/audio/classify/events
  apiRoute("post", "/audio/classify/events", log, auth, scope("write"), async (req, res) => {
    return wrapClassify(classifyEvents, "CLASSIFY_FAILED")(req, res, apiError);
  });

  // POST /api/v1/audio/classify/emotion
  apiRoute("post", "/audio/classify/emotion", log, auth, scope("write"), async (req, res) => {
    return wrapClassify(classifyEmotion, "CLASSIFY_FAILED")(req, res, apiError);
  });

  // POST /api/v1/audio/classify/acoustic
  apiRoute("post", "/audio/classify/acoustic", log, auth, scope("write"), async (req, res) => {
    return wrapClassify(classifyAcoustic, "CLASSIFY_FAILED")(req, res, apiError);
  });

  // POST /api/v1/audio/analyze
  apiRoute("post", "/audio/analyze", log, auth, scope("write"), async (req, res) => {
    try {
      const audio = extractAudio(req);
      if (!audio || audio.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "audio is required");
      }
      const body = req.body || {};
      const options = {
        sampleRate: parseSampleRate(body),
        audioId: typeof body.audioId === "string" ? body.audioId : undefined,
        includeFeatures: body.includeFeatures === true,
      };
      if (Array.isArray(body.domains)) {
        options.domains = body.domains;
      }
      const analysis = await analyzeAudio(audio, options);
      if (body.save === true && options.audioId) {
        await saveAnalysis(options.audioId, analysis);
      }
      return res.json({ _version: 1, analysis });
    } catch (err) {
      if (/invalid domain/i.test(err?.message || "")) {
        return apiError(res, 400, "INVALID_INPUT", err.message);
      }
      return apiError(res, 500, "ANALYZE_FAILED", err?.message || "analyze failed");
    }
  });

  // POST /api/v1/audio/segments
  apiRoute("post", "/audio/segments", log, auth, scope("write"), async (req, res) => {
    try {
      const audio = extractAudio(req);
      if (!audio || audio.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "audio is required");
      }
      const body = req.body || {};
      const segmentMs = Number(body.segmentMs);
      const windowMs = Number.isFinite(segmentMs) && segmentMs > 0 ? segmentMs : 1000;
      const options = { sampleRate: parseSampleRate(body) };
      const segments = await analyzeSegments(audio, windowMs, options);
      return res.json({ _version: 1, segments, count: segments.length });
    } catch (err) {
      return apiError(res, 500, "SEGMENT_FAILED", err?.message || "segment analysis failed");
    }
  });

  // GET /api/v1/audio/analysis/:id
  apiRoute("get", "/audio/analysis/:id", log, auth, scope("read"), async (req, res) => {
    try {
      const record = await getAnalysis(req.params.id);
      if (!record) {
        return apiError(res, 404, "NOT_FOUND", `analysis ${req.params.id} not found`);
      }
      return res.json({ _version: 1, analysis: record });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "lookup failed");
    }
  });

  // GET /api/v1/audio/analyses
  apiRoute("get", "/audio/analyses", log, auth, scope("read"), async (req, res) => {
    try {
      const q = req.query || {};
      const filter = {};
      if (q.audioId) filter.audioId = String(q.audioId);
      if (q.musicLabel) filter.musicLabel = String(q.musicLabel);
      if (q.emotionLabel) filter.emotionLabel = String(q.emotionLabel);
      if (q.eventLabel) filter.eventLabel = String(q.eventLabel);
      if (q.acousticLabel) filter.acousticLabel = String(q.acousticLabel);
      if (q.since) filter.since = String(q.since);
      if (q.until) filter.until = String(q.until);
      const items = await listAnalyses(filter);
      return res.json({ _version: 1, analyses: items, count: items.length });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err?.message || "list failed");
    }
  });
}

export default mountAudioClassificationRoutes;
