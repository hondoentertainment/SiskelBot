/**
 * Voice cloning: train and synthesize speech with custom voices.
 *
 * Stores raw user samples on disk under data/voice-samples/{userId}/.
 * Coordinates with provider adapters (ElevenLabs, OpenAI, local) to
 * train cloned voice models and generate speech in those voices.
 *
 * Storage layout:
 *   data/voice-samples/{userId}/{sampleId}.{ext}
 *   data/voice-samples/{userId}/index.json   -- per-user sample metadata
 *   data/voice-models.json                   -- voiceId -> model metadata
 *
 * @module lib/voice-cloning
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import * as elevenlabs from "./voice-providers/elevenlabs.js";

const STORAGE_PATH = process.env.STORAGE_PATH || "./data";
const VOICE_SAMPLES_DIR = path.join(STORAGE_PATH, "voice-samples");
const VOICE_MODELS_FILE = path.join(STORAGE_PATH, "voice-models.json");

const MIN_SAMPLE_DURATION_SECONDS = 30;
const MAX_SAMPLE_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_SAMPLES_PER_USER = Number(process.env.VOICE_MAX_SAMPLES_PER_USER || 25);
const MAX_VOICES_PER_USER = Number(process.env.VOICE_MAX_VOICES_PER_USER || 10);

const SUPPORTED_FORMATS = {
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
};

/**
 * Provider registry: declares the env var required to enable each provider
 * and the endpoints used by the adapter.
 */
export const VOICE_PROVIDERS = {
  elevenlabs: {
    requiresKey: "ELEVENLABS_API_KEY",
    endpoints: {
      train: "https://api.elevenlabs.io/v1/voices/add",
      synthesize: "https://api.elevenlabs.io/v1/text-to-speech/{voiceId}",
      stream: "https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream",
      list: "https://api.elevenlabs.io/v1/voices",
      get: "https://api.elevenlabs.io/v1/voices/{voiceId}",
      delete: "https://api.elevenlabs.io/v1/voices/{voiceId}",
    },
  },
  openai: {
    // OpenAI does not support true voice cloning yet, but supports voice presets.
    // We treat the chosen preset as the "voiceId".
    requiresKey: "OPENAI_API_KEY",
    presets: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
    endpoints: {
      synthesize: "https://api.openai.com/v1/audio/speech",
    },
  },
  local: {
    // Local stub provider — does no real synthesis but is useful for tests
    // and offline development. Always available.
    requiresKey: null,
  },
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function userDir(userId) {
  if (!userId || typeof userId !== "string") {
    throw Object.assign(new Error("userId is required"), { code: "INVALID_INPUT" });
  }
  // Defend against path traversal
  const safe = userId.replace(/[^a-zA-Z0-9_\-.]/g, "_");
  return path.join(VOICE_SAMPLES_DIR, safe);
}

function userIndexPath(userId) {
  return path.join(userDir(userId), "index.json");
}

function readUserIndex(userId) {
  const file = userIndexPath(userId);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeUserIndex(userId, list) {
  ensureDir(userDir(userId));
  fs.writeFileSync(userIndexPath(userId), JSON.stringify(list, null, 2));
}

function readVoiceModels() {
  if (!fs.existsSync(VOICE_MODELS_FILE)) return {};
  try {
    const raw = fs.readFileSync(VOICE_MODELS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeVoiceModels(models) {
  ensureDir(STORAGE_PATH);
  fs.writeFileSync(VOICE_MODELS_FILE, JSON.stringify(models, null, 2));
}

/**
 * Estimate audio duration in seconds. WAV files are parsed from headers,
 * other formats fall back to a rough byte-rate estimate.
 *
 * @param {Buffer} buf
 * @param {string} mimeType
 * @returns {number} duration in seconds
 */
export function estimateAudioDuration(buf, mimeType) {
  if (!buf || buf.length < 44) return 0;
  if (mimeType === "audio/wav" || mimeType === "audio/wave" || mimeType === "audio/x-wav") {
    try {
      // Check RIFF header
      if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE") {
        const byteRate = buf.readUInt32LE(28);
        const dataSize = buf.length - 44;
        if (byteRate > 0) return dataSize / byteRate;
      }
    } catch {
      /* fall through */
    }
  }
  // Rough estimate: assume 16 kB/sec (~128 kbps) average
  return Math.max(0, buf.length / 16000);
}

/**
 * Validate a voice sample for upload.
 * @param {Buffer} buf
 * @param {string} mimeType
 * @returns {{ valid: boolean, error?: string, duration?: number, ext?: string }}
 */
export function validateVoiceSample(buf, mimeType) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    return { valid: false, error: "Audio buffer is required and must be non-empty" };
  }
  if (buf.length > MAX_SAMPLE_BYTES) {
    return { valid: false, error: `Sample exceeds maximum size of ${MAX_SAMPLE_BYTES / 1024 / 1024}MB` };
  }
  const ext = SUPPORTED_FORMATS[mimeType];
  if (!ext) {
    return {
      valid: false,
      error: `Unsupported audio format: ${mimeType}. Supported: ${Object.keys(SUPPORTED_FORMATS).join(", ")}`,
    };
  }
  const duration = estimateAudioDuration(buf, mimeType);
  if (duration < MIN_SAMPLE_DURATION_SECONDS) {
    return {
      valid: false,
      error: `Sample too short: ${duration.toFixed(1)}s. Minimum is ${MIN_SAMPLE_DURATION_SECONDS}s.`,
      duration,
    };
  }
  return { valid: true, duration, ext };
}

/**
 * Upload a voice sample and persist it to disk.
 *
 * @param {string} userId
 * @param {Buffer} audioBuffer
 * @param {object} metadata
 * @param {string} metadata.mimeType
 * @param {string} [metadata.label]
 * @returns {Promise<{ sampleId: string, duration: number, format: string, bytes: number, label?: string, createdAt: string }>}
 */
export async function uploadVoiceSample(userId, audioBuffer, metadata = {}) {
  const mimeType = metadata.mimeType || metadata.format;
  const validation = validateVoiceSample(audioBuffer, mimeType);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.error), { code: "INVALID_INPUT" });
  }

  const existing = readUserIndex(userId);
  if (existing.length >= MAX_SAMPLES_PER_USER) {
    throw Object.assign(
      new Error(`Voice sample quota exceeded (${MAX_SAMPLES_PER_USER} max). Delete old samples first.`),
      { code: "QUOTA_EXCEEDED" }
    );
  }

  ensureDir(userDir(userId));

  const sampleId = `sample_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  const filename = `${sampleId}.${validation.ext}`;
  const filepath = path.join(userDir(userId), filename);
  fs.writeFileSync(filepath, audioBuffer);

  const record = {
    sampleId,
    userId,
    filename,
    mimeType,
    format: validation.ext,
    duration: validation.duration,
    bytes: audioBuffer.length,
    label: metadata.label || null,
    createdAt: new Date().toISOString(),
  };

  existing.push(record);
  writeUserIndex(userId, existing);

  return {
    sampleId,
    duration: validation.duration,
    format: validation.ext,
    bytes: audioBuffer.length,
    label: record.label,
    createdAt: record.createdAt,
  };
}

/**
 * List all uploaded voice samples for a user.
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function listUserSamples(userId) {
  return readUserIndex(userId).map((s) => ({
    sampleId: s.sampleId,
    duration: s.duration,
    format: s.format,
    bytes: s.bytes,
    label: s.label,
    createdAt: s.createdAt,
  }));
}

/**
 * Read the binary contents of a stored sample.
 * @param {string} userId
 * @param {string} sampleId
 * @returns {Promise<{ buffer: Buffer, mimeType: string, filename: string }>}
 */
export async function readSampleBuffer(userId, sampleId) {
  const list = readUserIndex(userId);
  const record = list.find((s) => s.sampleId === sampleId);
  if (!record) {
    throw Object.assign(new Error(`Sample not found: ${sampleId}`), { code: "NOT_FOUND" });
  }
  const filepath = path.join(userDir(userId), record.filename);
  if (!fs.existsSync(filepath)) {
    throw Object.assign(new Error(`Sample file missing on disk: ${sampleId}`), { code: "NOT_FOUND" });
  }
  return {
    buffer: fs.readFileSync(filepath),
    mimeType: record.mimeType,
    filename: record.filename,
  };
}

/**
 * Delete a voice sample by id.
 * @param {string} userId
 * @param {string} sampleId
 */
export async function deleteVoiceSample(userId, sampleId) {
  const list = readUserIndex(userId);
  const idx = list.findIndex((s) => s.sampleId === sampleId);
  if (idx === -1) {
    throw Object.assign(new Error(`Sample not found: ${sampleId}`), { code: "NOT_FOUND" });
  }
  const record = list[idx];
  const filepath = path.join(userDir(userId), record.filename);
  try {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  } catch {
    /* ignore */
  }
  list.splice(idx, 1);
  writeUserIndex(userId, list);
  return { sampleId, deleted: true };
}

function selectAdapter(provider) {
  if (provider === "elevenlabs") return elevenlabs;
  if (provider === "openai") {
    return {
      async addVoice() {
        // Not supported — return a deterministic preset id
        return { voiceId: "alloy", status: "ready" };
      },
      async synthesize(voiceId, text) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          throw Object.assign(new Error("OPENAI_API_KEY is not set"), { code: "VOICE_NOT_CONFIGURED" });
        }
        const res = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: "tts-1", input: text, voice: voiceId, response_format: "mp3" }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw Object.assign(
            new Error(`OpenAI TTS error: HTTP ${res.status} ${body.slice(0, 300)}`),
            { code: "BACKEND_ERROR", status: res.status }
          );
        }
        const ab = await res.arrayBuffer();
        return { audio: Buffer.from(ab), format: "mp3", duration: 0 };
      },
      async getStatus() {
        return { status: "ready" };
      },
      async deleteVoice() {
        return { deleted: true };
      },
    };
  }
  if (provider === "local") {
    return {
      async addVoice(_samples, options) {
        const voiceId = `local_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
        return { voiceId, status: "ready", name: options?.voiceName || "local-voice" };
      },
      async synthesize(_voiceId, text) {
        // Generate a deterministic placeholder buffer derived from the text
        const audio = Buffer.from(`LOCAL_TTS:${text}`, "utf8");
        return { audio, format: "wav", duration: text.length * 0.06 };
      },
      async getStatus() {
        return { status: "ready" };
      },
      async deleteVoice() {
        return { deleted: true };
      },
    };
  }
  throw Object.assign(new Error(`Unknown voice provider: ${provider}`), { code: "INVALID_INPUT" });
}

function isProviderConfigured(provider) {
  const cfg = VOICE_PROVIDERS[provider];
  if (!cfg) return false;
  if (!cfg.requiresKey) return true;
  return Boolean(process.env[cfg.requiresKey]);
}

/**
 * Train a voice model from previously uploaded samples.
 *
 * @param {string} userId
 * @param {string[]} sampleIds
 * @param {object} options
 * @param {"elevenlabs"|"openai"|"local"} options.provider
 * @param {string} options.voiceName
 * @param {string} [options.description]
 * @returns {Promise<{ voiceId: string, status: string, estimatedTime: number, provider: string, voiceName: string }>}
 */
export async function trainVoiceModel(userId, sampleIds, options = {}) {
  if (!Array.isArray(sampleIds) || sampleIds.length === 0) {
    throw Object.assign(new Error("At least one sampleId is required"), { code: "INVALID_INPUT" });
  }
  const provider = options.provider || "local";
  if (!VOICE_PROVIDERS[provider]) {
    throw Object.assign(new Error(`Unknown provider: ${provider}`), { code: "INVALID_INPUT" });
  }
  if (!isProviderConfigured(provider)) {
    throw Object.assign(
      new Error(`Provider ${provider} not configured. Set ${VOICE_PROVIDERS[provider].requiresKey}.`),
      { code: "PROVIDER_NOT_CONFIGURED" }
    );
  }
  if (!options.voiceName || typeof options.voiceName !== "string") {
    throw Object.assign(new Error("voiceName is required"), { code: "INVALID_INPUT" });
  }

  // Quota check on cloned voices per user
  const allModels = readVoiceModels();
  const userVoiceCount = Object.values(allModels).filter((m) => m.userId === userId).length;
  if (userVoiceCount >= MAX_VOICES_PER_USER) {
    throw Object.assign(
      new Error(`Voice quota exceeded (${MAX_VOICES_PER_USER} max). Delete a voice first.`),
      { code: "QUOTA_EXCEEDED" }
    );
  }

  // Load sample buffers
  const sampleBuffers = [];
  for (const sid of sampleIds) {
    const data = await readSampleBuffer(userId, sid);
    sampleBuffers.push({ sampleId: sid, ...data });
  }

  const adapter = selectAdapter(provider);
  const result = await adapter.addVoice(sampleBuffers, {
    voiceName: options.voiceName,
    description: options.description || "",
  });

  const voiceId = result.voiceId;
  const status = result.status || "training";
  const estimatedTime = typeof result.estimatedTime === "number" ? result.estimatedTime : 60;

  allModels[voiceId] = {
    voiceId,
    userId,
    provider,
    voiceName: options.voiceName,
    description: options.description || "",
    sampleIds: [...sampleIds],
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeVoiceModels(allModels);

  return {
    voiceId,
    status,
    estimatedTime,
    provider,
    voiceName: options.voiceName,
  };
}

/**
 * List cloned voices for a user.
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function listUserVoices(userId) {
  const all = readVoiceModels();
  return Object.values(all)
    .filter((m) => m.userId === userId)
    .map((m) => ({
      voiceId: m.voiceId,
      voiceName: m.voiceName,
      provider: m.provider,
      status: m.status,
      sampleCount: Array.isArray(m.sampleIds) ? m.sampleIds.length : 0,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
}

/**
 * Delete a cloned voice (both locally and on the provider).
 * @param {string} userId
 * @param {string} voiceId
 */
export async function deleteVoice(userId, voiceId) {
  const all = readVoiceModels();
  const model = all[voiceId];
  if (!model) {
    throw Object.assign(new Error(`Voice not found: ${voiceId}`), { code: "NOT_FOUND" });
  }
  if (model.userId !== userId) {
    throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });
  }
  try {
    const adapter = selectAdapter(model.provider);
    await adapter.deleteVoice(voiceId);
  } catch (err) {
    // Don't fail the local delete because the provider call failed.
    // Bubble up only configuration / validation errors.
    if (err.code === "INVALID_INPUT") throw err;
  }
  delete all[voiceId];
  writeVoiceModels(all);
  return { voiceId, deleted: true };
}

/**
 * Synthesize speech using a previously trained cloned voice.
 *
 * @param {string} voiceId
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.format] - mp3, wav, etc.
 * @param {number} [options.stability]
 * @param {number} [options.similarityBoost]
 * @returns {Promise<{ audio: Buffer, duration: number, format: string, contentType: string }>}
 */
export async function synthesizeWithClonedVoice(voiceId, text, options = {}) {
  if (!voiceId || typeof voiceId !== "string") {
    throw Object.assign(new Error("voiceId is required"), { code: "INVALID_INPUT" });
  }
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    throw Object.assign(new Error("text is required"), { code: "INVALID_INPUT" });
  }
  if (text.length > 5000) {
    throw Object.assign(new Error("text exceeds 5000 char limit"), { code: "INVALID_INPUT" });
  }

  const all = readVoiceModels();
  const model = all[voiceId];
  // For openai presets we allow synthesis without a stored model
  let provider = model?.provider;
  if (!provider) {
    if (VOICE_PROVIDERS.openai.presets.includes(voiceId)) {
      provider = "openai";
    } else {
      throw Object.assign(new Error(`Voice not found: ${voiceId}`), { code: "NOT_FOUND" });
    }
  }
  if (model && model.status !== "ready") {
    throw Object.assign(
      new Error(`Voice not ready (status: ${model.status})`),
      { code: "NOT_READY" }
    );
  }
  if (!isProviderConfigured(provider)) {
    throw Object.assign(
      new Error(`Provider ${provider} not configured`),
      { code: "PROVIDER_NOT_CONFIGURED" }
    );
  }

  const adapter = selectAdapter(provider);
  const result = await adapter.synthesize(voiceId, text, options);

  const format = result.format || options.format || "mp3";
  const contentTypeMap = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    opus: "audio/opus",
    flac: "audio/flac",
    ogg: "audio/ogg",
  };

  return {
    audio: result.audio,
    duration: result.duration || 0,
    format,
    contentType: contentTypeMap[format] || "application/octet-stream",
  };
}

/**
 * Poll the provider for the latest training status and refresh the local model record.
 *
 * @param {string} voiceId
 * @returns {Promise<{ voiceId: string, status: string, provider: string, updatedAt: string }>}
 */
export async function getVoiceTrainingStatus(voiceId) {
  const all = readVoiceModels();
  const model = all[voiceId];
  if (!model) {
    throw Object.assign(new Error(`Voice not found: ${voiceId}`), { code: "NOT_FOUND" });
  }
  let status = model.status;
  try {
    const adapter = selectAdapter(model.provider);
    const remote = await adapter.getStatus(voiceId);
    if (remote && remote.status) {
      status = remote.status;
      model.status = status;
      model.updatedAt = new Date().toISOString();
      all[voiceId] = model;
      writeVoiceModels(all);
    }
  } catch {
    /* fall through with cached status */
  }
  return {
    voiceId,
    status,
    provider: model.provider,
    updatedAt: model.updatedAt,
  };
}

/**
 * Test-only helper: clear all stored voice models and samples for a user.
 * @param {string} [userId] - if omitted, clears everything
 */
export function _resetForTests(userId) {
  if (userId) {
    try {
      const dir = userDir(userId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const all = readVoiceModels();
    for (const [vid, m] of Object.entries(all)) {
      if (m.userId === userId) delete all[vid];
    }
    writeVoiceModels(all);
    return;
  }
  try {
    if (fs.existsSync(VOICE_SAMPLES_DIR)) fs.rmSync(VOICE_SAMPLES_DIR, { recursive: true, force: true });
    if (fs.existsSync(VOICE_MODELS_FILE)) fs.unlinkSync(VOICE_MODELS_FILE);
  } catch {
    /* ignore */
  }
}

export const _internals = {
  MIN_SAMPLE_DURATION_SECONDS,
  MAX_SAMPLE_BYTES,
  MAX_SAMPLES_PER_USER,
  MAX_VOICES_PER_USER,
  SUPPORTED_FORMATS,
  selectAdapter,
  isProviderConfigured,
};
