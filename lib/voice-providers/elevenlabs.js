/**
 * ElevenLabs voice cloning adapter.
 *
 * Implements the standard adapter interface used by lib/voice-cloning.js:
 *   - addVoice(samples, options) -> { voiceId, status, estimatedTime }
 *   - synthesize(voiceId, text, options) -> { audio, format, duration }
 *   - synthesizeStream(voiceId, text, options) -> AsyncIterable<Buffer>
 *   - getStatus(voiceId) -> { status }
 *   - listVoices() -> Array
 *   - getVoice(voiceId) -> object
 *   - deleteVoice(voiceId) -> { deleted }
 *
 * No SDK is used — all calls are direct REST against api.elevenlabs.io.
 *
 * @module lib/voice-providers/elevenlabs
 */

const BASE_URL = process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io";
const DEFAULT_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw Object.assign(
      new Error("ELEVENLABS_API_KEY is not set"),
      { code: "PROVIDER_NOT_CONFIGURED" }
    );
  }
  return key;
}

function authHeaders(extra = {}) {
  return {
    "xi-api-key": apiKey(),
    Accept: "application/json",
    ...extra,
  };
}

async function readError(res, label) {
  const body = await res.text().catch(() => "");
  return Object.assign(
    new Error(`${label}: HTTP ${res.status} ${body.slice(0, 300)}`),
    { code: "BACKEND_ERROR", status: res.status }
  );
}

/**
 * Add a new voice to the ElevenLabs voice library by uploading sample files.
 *
 * @param {Array<{ buffer: Buffer, filename: string, mimeType: string }>} samples
 * @param {object} options
 * @param {string} options.voiceName
 * @param {string} [options.description]
 * @param {object} [options.labels]
 * @returns {Promise<{ voiceId: string, status: string, estimatedTime: number }>}
 */
export async function addVoice(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw Object.assign(new Error("At least one sample is required"), { code: "INVALID_INPUT" });
  }
  if (!options.voiceName) {
    throw Object.assign(new Error("voiceName is required"), { code: "INVALID_INPUT" });
  }

  const form = new FormData();
  form.append("name", options.voiceName);
  if (options.description) form.append("description", options.description);
  if (options.labels) form.append("labels", JSON.stringify(options.labels));

  for (const sample of samples) {
    const blob = new Blob([sample.buffer], { type: sample.mimeType || "audio/mpeg" });
    form.append("files", blob, sample.filename || "sample.mp3");
  }

  const res = await fetch(`${BASE_URL}/v1/voices/add`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });

  if (!res.ok) throw await readError(res, "ElevenLabs voices/add");

  const data = await res.json();
  return {
    voiceId: data.voice_id || data.voiceId,
    // ElevenLabs returns the voice as immediately usable.
    status: "ready",
    estimatedTime: 0,
  };
}

/**
 * Generate speech for a given voice id. Returns the full audio buffer.
 *
 * @param {string} voiceId
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.modelId]
 * @param {string} [options.format] - mp3, wav, etc.
 * @param {number} [options.stability]
 * @param {number} [options.similarityBoost]
 * @param {number} [options.style]
 * @param {boolean} [options.useSpeakerBoost]
 * @returns {Promise<{ audio: Buffer, format: string, duration: number }>}
 */
export async function synthesize(voiceId, text, options = {}) {
  if (!voiceId) {
    throw Object.assign(new Error("voiceId is required"), { code: "INVALID_INPUT" });
  }
  if (!text || typeof text !== "string") {
    throw Object.assign(new Error("text is required"), { code: "INVALID_INPUT" });
  }

  const body = {
    text,
    model_id: options.modelId || DEFAULT_MODEL,
    voice_settings: {
      stability: typeof options.stability === "number" ? options.stability : 0.5,
      similarity_boost: typeof options.similarityBoost === "number" ? options.similarityBoost : 0.75,
      style: typeof options.style === "number" ? options.style : 0,
      use_speaker_boost: options.useSpeakerBoost !== false,
    },
  };

  const format = options.format || "mp3";

  const res = await fetch(`${BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      Accept: format === "mp3" ? "audio/mpeg" : `audio/${format}`,
    }),
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await readError(res, "ElevenLabs text-to-speech");

  const ab = await res.arrayBuffer();
  return {
    audio: Buffer.from(ab),
    format,
    duration: 0,
  };
}

/**
 * Stream synthesized speech as it is generated. Yields raw byte chunks.
 *
 * @param {string} voiceId
 * @param {string} text
 * @param {object} [options]
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* synthesizeStream(voiceId, text, options = {}) {
  if (!voiceId || !text) {
    throw Object.assign(new Error("voiceId and text are required"), { code: "INVALID_INPUT" });
  }

  const body = {
    text,
    model_id: options.modelId || DEFAULT_MODEL,
    voice_settings: {
      stability: typeof options.stability === "number" ? options.stability : 0.5,
      similarity_boost: typeof options.similarityBoost === "number" ? options.similarityBoost : 0.75,
    },
  };

  const res = await fetch(`${BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`, {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    }),
    body: JSON.stringify(body),
  });

  if (!res.ok) throw await readError(res, "ElevenLabs stream");
  if (!res.body) return;

  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) yield Buffer.from(value);
  }
}

/**
 * List all voices in the ElevenLabs library (cloned + premade).
 * @returns {Promise<Array<{ voiceId: string, name: string, category: string }>>}
 */
export async function listVoices() {
  const res = await fetch(`${BASE_URL}/v1/voices`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!res.ok) throw await readError(res, "ElevenLabs list voices");
  const data = await res.json();
  const voices = Array.isArray(data.voices) ? data.voices : [];
  return voices.map((v) => ({
    voiceId: v.voice_id,
    name: v.name,
    category: v.category || "unknown",
    description: v.description || "",
    previewUrl: v.preview_url || null,
  }));
}

/**
 * Get a single voice by id.
 * @param {string} voiceId
 */
export async function getVoice(voiceId) {
  if (!voiceId) {
    throw Object.assign(new Error("voiceId is required"), { code: "INVALID_INPUT" });
  }
  const res = await fetch(`${BASE_URL}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!res.ok) throw await readError(res, "ElevenLabs get voice");
  const data = await res.json();
  return {
    voiceId: data.voice_id,
    name: data.name,
    category: data.category || "unknown",
    description: data.description || "",
    labels: data.labels || {},
    settings: data.settings || null,
  };
}

/**
 * Get training/availability status for a voice. ElevenLabs voices are
 * immediately usable after upload, so this normally returns "ready".
 *
 * @param {string} voiceId
 * @returns {Promise<{ status: string }>}
 */
export async function getStatus(voiceId) {
  try {
    await getVoice(voiceId);
    return { status: "ready" };
  } catch (err) {
    if (err.status === 404) return { status: "missing" };
    throw err;
  }
}

/**
 * Delete a voice from the ElevenLabs voice library.
 * @param {string} voiceId
 */
export async function deleteVoice(voiceId) {
  if (!voiceId) {
    throw Object.assign(new Error("voiceId is required"), { code: "INVALID_INPUT" });
  }
  const res = await fetch(`${BASE_URL}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    throw await readError(res, "ElevenLabs delete voice");
  }
  return { deleted: true };
}
