/**
 * Phase 44.3: Speaker diarization routes.
 *
 * POST   /api/v1/voice/diarize                 — upload audio, get diarized transcript
 * POST   /api/v1/voice/speakers                — enroll a speaker
 * GET    /api/v1/voice/speakers                — list enrolled speakers
 * DELETE /api/v1/voice/speakers/:id            — remove enrolled speaker
 * POST   /api/v1/voice/identify                — identify speaker in audio
 * GET    /api/v1/voice/diarize/:jobId/export   — export stored transcript
 * GET    /api/v1/voice/diarize/capabilities    — provider availability
 */

import multer from "multer";
import { randomUUID } from "node:crypto";
import {
  diarizeAudio,
  transcribeWithDiarization,
  enrollSpeaker,
  listSpeakers,
  deleteSpeaker,
  identifySpeaker,
  exportTranscript,
  getDiarizationCapabilities,
  storeJob,
  getJob,
} from "../lib/diarization.js";

const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
];

export function mountDiarizationRoutes(app, deps) {
  const { apiRoute, apiError, logRequest } = deps;

  const audioUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AUDIO_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
      if (!file.mimetype || ALLOWED_AUDIO_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error(`invalid audio type: ${file.mimetype}`), false);
    },
  });

  const rateLimiter = deps.rateLimit
    ? deps.rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false })
    : (_req, _res, next) => next();

  function uploadAudio(field) {
    return (req, res, next) => {
      audioUpload.single(field)(req, res, (err) => {
        if (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              return apiError(res, 400, "FILE_TOO_LARGE", `audio exceeds ${AUDIO_MAX_BYTES / 1024 / 1024}MB`);
            }
            if (err.code === "LIMIT_UNEXPECTED_FILE") {
              return apiError(res, 400, "INVALID_BODY", `use field name '${field}' for audio upload`);
            }
          }
          return apiError(res, 400, "INVALID_FILE", err.message || "invalid audio upload");
        }
        next();
      });
    };
  }

  // GET /api/v1/voice/diarize/capabilities
  apiRoute("get", "/voice/diarize/capabilities", logRequest, async (_req, res) => {
    try {
      res.json(getDiarizationCapabilities());
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/voice/diarize
  apiRoute(
    "post",
    "/voice/diarize",
    rateLimiter,
    uploadAudio("audio"),
    logRequest,
    async (req, res) => {
      try {
        if (!req.file?.buffer) {
          return apiError(res, 400, "INVALID_BODY", "audio file required (multipart/form-data)");
        }
        const provider = req.body?.provider || undefined;
        const language = req.body?.language || undefined;
        const expectedSpeakers = req.body?.expectedSpeakers
          ? Number(req.body.expectedSpeakers)
          : undefined;

        const result = await transcribeWithDiarization(req.file.buffer, {
          provider,
          language,
          expectedSpeakers,
        });

        const jobId = `diar_${randomUUID()}`;
        storeJob(jobId, result);

        res.json({
          jobId,
          provider: result.provider,
          language: result.language,
          segments: result.segments,
          speakers: result.speakers,
          transcript: result.transcript,
          pending: result.pending || false,
        });
      } catch (err) {
        if (err.code === "INVALID_INPUT") return apiError(res, 400, "INVALID_INPUT", err.message);
        if (err.code === "DIARIZATION_NOT_CONFIGURED") {
          return apiError(res, 503, "DIARIZATION_NOT_CONFIGURED", err.message);
        }
        if (err.code === "BACKEND_ERROR") {
          return apiError(res, 502, "BACKEND_ERROR", err.message);
        }
        return apiError(res, 500, "DIARIZATION_FAILED", err.message);
      }
    }
  );

  // POST /api/v1/voice/speakers
  apiRoute(
    "post",
    "/voice/speakers",
    rateLimiter,
    uploadAudio("audio"),
    logRequest,
    async (req, res) => {
      try {
        if (!req.file?.buffer) {
          return apiError(res, 400, "INVALID_BODY", "audio sample file required");
        }
        const userId = req.body?.userId || req.userId || "anonymous";
        const displayName = req.body?.displayName;
        if (!displayName) {
          return apiError(res, 400, "INVALID_INPUT", "displayName is required");
        }
        const record = await enrollSpeaker(userId, req.file.buffer, displayName);
        res.status(201).json(record);
      } catch (err) {
        if (err.code === "INVALID_INPUT") return apiError(res, 400, "INVALID_INPUT", err.message);
        return apiError(res, 500, "ENROLL_FAILED", err.message);
      }
    }
  );

  // GET /api/v1/voice/speakers
  apiRoute("get", "/voice/speakers", logRequest, async (req, res) => {
    try {
      const userId = req.query?.userId || undefined;
      const speakers = await listSpeakers(userId);
      res.json({ speakers });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // DELETE /api/v1/voice/speakers/:id
  apiRoute("delete", "/voice/speakers/:id", logRequest, async (req, res) => {
    try {
      const ok = await deleteSpeaker(req.params.id);
      if (!ok) return apiError(res, 404, "NOT_FOUND", `speaker ${req.params.id} not found`);
      res.json({ deleted: true, speakerId: req.params.id });
    } catch (err) {
      return apiError(res, 500, "INTERNAL_ERROR", err.message);
    }
  });

  // POST /api/v1/voice/identify
  apiRoute(
    "post",
    "/voice/identify",
    rateLimiter,
    uploadAudio("audio"),
    logRequest,
    async (req, res) => {
      try {
        if (!req.file?.buffer) {
          return apiError(res, 400, "INVALID_BODY", "audio file required");
        }
        const match = await identifySpeaker(req.file.buffer);
        res.json(match);
      } catch (err) {
        if (err.code === "INVALID_INPUT") return apiError(res, 400, "INVALID_INPUT", err.message);
        return apiError(res, 500, "IDENTIFY_FAILED", err.message);
      }
    }
  );

  // GET /api/v1/voice/diarize/:jobId/export?format=srt
  apiRoute("get", "/voice/diarize/:jobId/export", logRequest, async (req, res) => {
    try {
      const job = getJob(req.params.jobId);
      if (!job) return apiError(res, 404, "NOT_FOUND", `job ${req.params.jobId} not found or expired`);
      const format = req.query?.format || "txt";
      const out = exportTranscript(job.segments, format);
      res.setHeader("Content-Type", out.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${out.filename}"`);
      res.send(out.data);
    } catch (err) {
      if (err.code === "INVALID_INPUT") return apiError(res, 400, "INVALID_INPUT", err.message);
      return apiError(res, 500, "EXPORT_FAILED", err.message);
    }
  });
}

export default mountDiarizationRoutes;
