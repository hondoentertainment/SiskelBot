/**
 * Voice routes: transcription, synthesis, capabilities.
 * POST /api/v1/voice/transcribe  — upload audio, get text
 * POST /api/v1/voice/synthesize  — send text, get audio
 * GET  /api/v1/voice/capabilities — check available features
 */

import multer from "multer";
import { transcribeAudio, synthesizeSpeech, isVoiceConfigured, validateAudioInput, validateTtsInput } from "../lib/voice.js";
import { getMultimodalCapabilities } from "../lib/multimodal-agent.js";

const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = [
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
];

export function mountVoiceRoutes(app, deps) {
  const {
    apiRoute,
    apiError,
    logRequest,
  } = deps;

  const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AUDIO_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      if (ALLOWED_AUDIO_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error(`Invalid audio type. Allowed: ${ALLOWED_AUDIO_TYPES.join(", ")}`), false);
    },
  });

  const voiceRateLimiter = deps.rateLimit
    ? deps.rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false })
    : (_req, _res, next) => next();

  // GET /api/v1/voice/capabilities
  apiRoute("get", "/voice/capabilities", async (_req, res) => {
    try {
      const voice = isVoiceConfigured();
      const multimodal = getMultimodalCapabilities();
      res.json({
        voice: {
          stt: voice.stt,
          tts: voice.tts,
          configured: voice.configured,
        },
        multimodal,
      });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/voice/transcribe
  apiRoute("post", "/voice/transcribe",
    voiceRateLimiter,
    (req, res, next) => {
      audioUpload.single("audio")(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE")
              return apiError(res, 400, "FILE_TOO_LARGE", `Audio exceeds ${AUDIO_MAX_BYTES / 1024 / 1024}MB limit`, "Reduce audio file size.");
            if (err.code === "LIMIT_UNEXPECTED_FILE")
              return apiError(res, 400, "INVALID_BODY", "Use field name 'audio' for multipart upload", null);
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

        const voiceConfig = isVoiceConfigured();
        if (!voiceConfig.stt) {
          return apiError(res, 503, "VOICE_NOT_CONFIGURED", "Speech-to-text not configured", "Set WHISPER_API_KEY or OPENAI_API_KEY.");
        }

        const language = req.body?.language || undefined;
        const model = req.body?.model || undefined;

        const result = await transcribeAudio(req.file.buffer, {
          model,
          language,
          format: req.file.mimetype,
        });

        res.json({
          text: result.text,
          language: result.language,
          duration: result.duration,
          confidence: result.confidence,
        });
      } catch (err) {
        if (err.code === "INVALID_INPUT") {
          return apiError(res, 400, "INVALID_INPUT", err.message);
        }
        if (err.code === "BACKEND_ERROR") {
          return apiError(res, 502, "BACKEND_ERROR", err.message, "Check API key and network connectivity.");
        }
        return apiError(res, 500, "TRANSCRIPTION_FAILED", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );

  // POST /api/v1/voice/synthesize
  apiRoute("post", "/voice/synthesize",
    voiceRateLimiter,
    logRequest,
    async (req, res) => {
      try {
        const { text, voice, speed, format } = req.body || {};

        if (!text) {
          return apiError(res, 400, "INVALID_BODY", "text is required", "Send JSON body with { text: '...' }.");
        }

        const voiceConfig = isVoiceConfigured();
        if (!voiceConfig.tts) {
          return apiError(res, 503, "VOICE_NOT_CONFIGURED", "Text-to-speech not configured", "Set OPENAI_API_KEY.");
        }

        const validation = validateTtsInput(text);
        if (!validation.valid) {
          return apiError(res, 400, "INVALID_INPUT", validation.error);
        }

        const result = await synthesizeSpeech(text, { voice, speed, format });

        res.setHeader("Content-Type", result.contentType);
        res.setHeader("Content-Length", result.audio.length);
        if (result.duration > 0) {
          res.setHeader("X-Audio-Duration", String(result.duration));
        }
        res.send(result.audio);
      } catch (err) {
        if (err.code === "INVALID_INPUT") {
          return apiError(res, 400, "INVALID_INPUT", err.message);
        }
        if (err.code === "BACKEND_ERROR") {
          return apiError(res, 502, "BACKEND_ERROR", err.message, "Check OPENAI_API_KEY and network connectivity.");
        }
        return apiError(res, 500, "SYNTHESIS_FAILED", err.message, "See docs/RUNBOOK.md.");
      }
    }
  );
}
