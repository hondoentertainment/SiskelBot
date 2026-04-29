/**
 * Voice interface: speech-to-text and text-to-speech.
 * Uses OpenAI Whisper API for transcription and OpenAI TTS API for synthesis.
 * @module lib/voice
 */

const SUPPORTED_AUDIO_FORMATS = new Set([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
  "audio/flac",
]);

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB (Whisper API limit)
const MAX_TTS_CHARS = 4096;

function voiceEnv() {
  return {
    whisperApiKey: process.env.WHISPER_API_KEY || "",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com",
    whisperModel: process.env.WHISPER_MODEL || "whisper-1",
    ttsModel: process.env.TTS_MODEL || "tts-1",
    ttsVoice: process.env.TTS_VOICE || "alloy",
  };
}

/**
 * Check whether voice features are configured.
 * STT requires WHISPER_API_KEY or OPENAI_API_KEY.
 * TTS requires OPENAI_API_KEY.
 * @returns {{ stt: boolean, tts: boolean, configured: boolean }}
 */
export function isVoiceConfigured() {
  const env = voiceEnv();
  const sttKey = env.whisperApiKey || env.openaiApiKey;
  const ttsKey = env.openaiApiKey;
  return {
    stt: Boolean(sttKey),
    tts: Boolean(ttsKey),
    configured: Boolean(sttKey || ttsKey),
  };
}

/**
 * Validate an audio buffer for transcription.
 * @param {Buffer} audioBuffer
 * @param {string} [mimeType]
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateAudioInput(audioBuffer, mimeType) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return { valid: false, error: "Audio buffer is required and must be non-empty" };
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    return { valid: false, error: `Audio exceeds maximum size of ${MAX_AUDIO_BYTES / 1024 / 1024}MB` };
  }
  if (mimeType && !SUPPORTED_AUDIO_FORMATS.has(mimeType)) {
    return { valid: false, error: `Unsupported audio format: ${mimeType}. Supported: ${[...SUPPORTED_AUDIO_FORMATS].join(", ")}` };
  }
  return { valid: true };
}

/**
 * Validate text input for synthesis.
 * @param {string} text
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateTtsInput(text) {
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return { valid: false, error: "Text is required and must be a non-empty string" };
  }
  if (text.length > MAX_TTS_CHARS) {
    return { valid: false, error: `Text exceeds maximum length of ${MAX_TTS_CHARS} characters` };
  }
  return { valid: true };
}

/**
 * Transcribe audio to text using OpenAI Whisper API.
 * @param {Buffer} audioBuffer - Raw audio data
 * @param {object} [options]
 * @param {string} [options.model] - Whisper model (default: whisper-1)
 * @param {string} [options.language] - ISO-639-1 language code
 * @param {string} [options.format] - Audio MIME type (for filename hint)
 * @returns {Promise<{ text: string, language: string, duration: number, confidence: number }>}
 */
export async function transcribeAudio(audioBuffer, options = {}) {
  const env = voiceEnv();
  const apiKey = env.whisperApiKey || env.openaiApiKey;
  if (!apiKey) {
    throw Object.assign(
      new Error("Speech-to-text not configured. Set WHISPER_API_KEY or OPENAI_API_KEY."),
      { code: "VOICE_NOT_CONFIGURED" }
    );
  }

  const validation = validateAudioInput(audioBuffer, options.format);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.error), { code: "INVALID_INPUT" });
  }

  const model = options.model || env.whisperModel;
  const ext = mimeToExt(options.format) || "wav";

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer]), `audio.${ext}`);
  formData.append("model", model);
  formData.append("response_format", "verbose_json");
  if (options.language) {
    formData.append("language", options.language);
  }

  const res = await fetch(`${env.openaiBaseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`Whisper API error: HTTP ${res.status} ${body.slice(0, 300)}`),
      { code: "BACKEND_ERROR", status: res.status }
    );
  }

  const data = await res.json();
  return {
    text: data.text || "",
    language: data.language || options.language || "unknown",
    duration: data.duration || 0,
    confidence: typeof data.confidence === "number" ? data.confidence : 1.0,
  };
}

/**
 * Synthesize speech from text using OpenAI TTS API.
 * @param {string} text - Text to synthesize
 * @param {object} [options]
 * @param {string} [options.voice] - Voice name (default: alloy)
 * @param {number} [options.speed] - Speed multiplier 0.25-4.0 (default: 1.0)
 * @param {string} [options.format] - Output format: mp3, opus, aac, flac (default: mp3)
 * @returns {Promise<{ audio: Buffer, contentType: string, duration: number }>}
 */
export async function synthesizeSpeech(text, options = {}) {
  const env = voiceEnv();
  if (!env.openaiApiKey) {
    throw Object.assign(
      new Error("Text-to-speech not configured. Set OPENAI_API_KEY."),
      { code: "VOICE_NOT_CONFIGURED" }
    );
  }

  const validation = validateTtsInput(text);
  if (!validation.valid) {
    throw Object.assign(new Error(validation.error), { code: "INVALID_INPUT" });
  }

  const voice = options.voice || env.ttsVoice;
  const speed = Math.max(0.25, Math.min(4.0, Number(options.speed) || 1.0));
  const format = options.format || "mp3";
  const validFormats = ["mp3", "opus", "aac", "flac"];
  if (!validFormats.includes(format)) {
    throw Object.assign(
      new Error(`Invalid format "${format}". Supported: ${validFormats.join(", ")}`),
      { code: "INVALID_INPUT" }
    );
  }

  const res = await fetch(`${env.openaiBaseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: env.ttsModel,
      input: text,
      voice,
      speed,
      response_format: format,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(
      new Error(`TTS API error: HTTP ${res.status} ${body.slice(0, 300)}`),
      { code: "BACKEND_ERROR", status: res.status }
    );
  }

  const arrayBuf = await res.arrayBuffer();
  const audio = Buffer.from(arrayBuf);

  const contentTypeMap = {
    mp3: "audio/mpeg",
    opus: "audio/opus",
    aac: "audio/aac",
    flac: "audio/flac",
  };

  return {
    audio,
    contentType: contentTypeMap[format] || "audio/mpeg",
    duration: 0, // duration not available from TTS API response
  };
}

function mimeToExt(mime) {
  const map = {
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
  };
  return map[mime] || null;
}
