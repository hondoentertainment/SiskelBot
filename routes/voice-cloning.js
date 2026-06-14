/**
 * Phase 44.2: Voice cloning routes.
 *
 * POST   /api/v1/voice/samples              — upload a voice sample (multipart)
 * GET    /api/v1/voice/samples              — list samples for a user
 * DELETE /api/v1/voice/samples/:id          — delete a sample
 * POST   /api/v1/voice/clone                — train cloned voice from samples
 * GET    /api/v1/voice/voices               — list cloned voices for a user
 * GET    /api/v1/voice/voices/:id/status    — poll training status
 * DELETE /api/v1/voice/voices/:id           — delete a cloned voice
 * POST   /api/v1/voice/synthesize/:voiceId  — synthesize speech with a cloned voice
 */

import multer from "multer";
import {
  uploadVoiceSample,
  listUserSamples,
  deleteVoiceSample,
  trainVoiceModel,
  listUserVoices,
  deleteVoice,
  synthesizeWithClonedVoice,
  getVoiceTrainingStatus,
  VOICE_PROVIDERS,
} from "../lib/voice-cloning.js";

const SAMPLE_MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_TYPES = [
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
];

function resolveUserId(req) {
  return (
    req.userId ||
    req.query?.userId ||
    req.body?.userId ||
    "anonymous"
  );
}

export function mountVoiceCloningRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SAMPLE_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error(`Invalid audio type: ${file.mimetype}. Allowed: ${ALLOWED_TYPES.join(", ")}`), false);
    },
  });

  const limiter = deps.rateLimit
    ? deps.rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })
    : (_req, _res, next) => next();

  // GET /api/v1/voice/providers — list configured providers (helper)
  apiRoute("get", "/voice/providers", async (_req, res) => {
    try {
      const providers = Object.entries(VOICE_PROVIDERS).map(([name, cfg]) => ({
        name,
        configured: !cfg.requiresKey || Boolean(process.env[cfg.requiresKey]),
        requiresKey: cfg.requiresKey || null,
      }));
      res.json({ providers });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/voice/samples — multipart upload of a voice sample
  apiRoute(
    "post",
    "/voice/samples",
    limiter,
    (req, res, next) => {
      upload.single("audio")(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              return apiError(res, 400, "FILE_TOO_LARGE", `Sample exceeds ${SAMPLE_MAX_BYTES / 1024 / 1024}MB limit`, "Compress or trim the sample.");
            }
            if (err.code === "LIMIT_UNEXPECTED_FILE") {
              return apiError(res, 400, "INVALID_BODY", "Use field name 'audio' for multipart upload", null);
            }
          }
          return apiError(res, 400, "INVALID_FILE", err.message || "Invalid audio upload", null);
        }
        next();
      });
    },
    logRequest,
    async (req, res) => {
      try {
        if (!req.file?.buffer) {
          return apiError(res, 400, "INVALID_BODY", "audio file required (multipart/form-data)", "Upload an audio file with field name 'audio'.");
        }
        const userId = resolveUserId(req);
        const result = await uploadVoiceSample(userId, req.file.buffer, {
          mimeType: req.file.mimetype,
          label: req.body?.label || null,
        });
        res.json({ ok: true, sample: result });
      } catch (err) {
        if (err.code === "INVALID_INPUT") return apiError(res, 400, "INVALID_INPUT", err.message);
        if (err.code === "QUOTA_EXCEEDED") return apiError(res, 429, "QUOTA_EXCEEDED", err.message);
        return apiError(res, 500, "SAMPLE_UPLOAD_FAILED", err.message);
      }
    }
  );

  // GET /api/v1/voice/samples — list samples for the current user (or ?userId=)
  apiRoute("get", "/voice/samples", limiter, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const samples = await listUserSamples(userId);
      res.json({ userId, samples });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/voice/samples/:id — delete a sample
  apiRoute("delete", "/voice/samples/:id", limiter, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const sampleId = String(req.params.id || "");
      if (!sampleId) return apiError(res, 400, "INVALID_INPUT", "sample id is required");
      const result = await deleteVoiceSample(userId, sampleId);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.code === "NOT_FOUND") return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "DELETE_FAILED", err.message);
    }
  });

  // POST /api/v1/voice/clone — train a voice model from sample ids
  apiRoute("post", "/voice/clone", limiter, logRequest, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const { sampleIds, provider, voiceName, description } = req.body || {};
      if (!Array.isArray(sampleIds) || sampleIds.length === 0) {
        return apiError(res, 400, "INVALID_INPUT", "sampleIds (array) is required");
      }
      if (!voiceName) {
        return apiError(res, 400, "INVALID_INPUT", "voiceName is required");
      }
      const result = await trainVoiceModel(userId, sampleIds, {
        provider: provider || "local",
        voiceName,
        description,
      });
      res.json({ ok: true, voice: result });
    } catch (err) {
      if (err.code === "INVALID_INPUT") return apiError(res, 400, "INVALID_INPUT", err.message);
      if (err.code === "NOT_FOUND") return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.code === "QUOTA_EXCEEDED") return apiError(res, 429, "QUOTA_EXCEEDED", err.message);
      if (err.code === "PROVIDER_NOT_CONFIGURED") {
        return apiError(res, 503, "PROVIDER_NOT_CONFIGURED", err.message);
      }
      if (err.code === "BACKEND_ERROR") {
        return apiError(res, 502, "BACKEND_ERROR", err.message, "Check provider API key and connectivity.");
      }
      return apiError(res, 500, "TRAINING_FAILED", err.message);
    }
  });

  // GET /api/v1/voice/voices — list cloned voices for the user
  apiRoute("get", "/voice/voices", limiter, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const voices = await listUserVoices(userId);
      res.json({ userId, voices });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // GET /api/v1/voice/voices/:id/status — poll training status
  apiRoute("get", "/voice/voices/:id/status", limiter, async (req, res) => {
    try {
      const voiceId = String(req.params.id || "");
      if (!voiceId) return apiError(res, 400, "INVALID_INPUT", "voiceId is required");
      const status = await getVoiceTrainingStatus(voiceId);
      res.json(status);
    } catch (err) {
      if (err.code === "NOT_FOUND") return apiError(res, 404, "NOT_FOUND", err.message);
      return apiError(res, 500, "STATUS_FAILED", err.message);
    }
  });

  // DELETE /api/v1/voice/voices/:id — delete a cloned voice
  apiRoute("delete", "/voice/voices/:id", limiter, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const voiceId = String(req.params.id || "");
      if (!voiceId) return apiError(res, 400, "INVALID_INPUT", "voiceId is required");
      const result = await deleteVoice(userId, voiceId);
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err.code === "NOT_FOUND") return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.code === "FORBIDDEN") return apiError(res, 403, "FORBIDDEN", err.message);
      return apiError(res, 500, "DELETE_FAILED", err.message);
    }
  });

  // POST /api/v1/voice/synthesize/:voiceId — generate speech in cloned voice
  apiRoute("post", "/voice/synthesize/:voiceId", limiter, logRequest, async (req, res) => {
    try {
      const voiceId = String(req.params.voiceId || "");
      const { text, format, stability, similarityBoost } = req.body || {};
      if (!voiceId) return apiError(res, 400, "INVALID_INPUT", "voiceId is required");
      if (!text) return apiError(res, 400, "INVALID_BODY", "text is required");

      const result = await synthesizeWithClonedVoice(voiceId, text, {
        format,
        stability,
        similarityBoost,
      });

      res.setHeader("Content-Type", result.contentType);
      res.setHeader("Content-Length", result.audio.length);
      if (result.duration > 0) {
        res.setHeader("X-Audio-Duration", String(result.duration));
      }
      res.send(result.audio);
    } catch (err) {
      if (err.code === "INVALID_INPUT") return apiError(res, 400, "INVALID_INPUT", err.message);
      if (err.code === "NOT_FOUND") return apiError(res, 404, "NOT_FOUND", err.message);
      if (err.code === "NOT_READY") return apiError(res, 409, "NOT_READY", err.message);
      if (err.code === "PROVIDER_NOT_CONFIGURED") {
        return apiError(res, 503, "PROVIDER_NOT_CONFIGURED", err.message);
      }
      if (err.code === "BACKEND_ERROR") {
        return apiError(res, 502, "BACKEND_ERROR", err.message);
      }
      return apiError(res, 500, "SYNTHESIS_FAILED", err.message);
    }
  });
}

export default mountVoiceCloningRoutes;
