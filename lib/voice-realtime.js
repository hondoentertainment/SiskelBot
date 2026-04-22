/**
 * Phase 44.1: Real-time voice conversation with low latency.
 *
 * Provides streaming STT (speech-to-text), streaming TTS (text-to-speech),
 * and Voice Activity Detection (VAD) for end-of-utterance detection.
 *
 * Targets <500ms end-to-end latency from user finishing a sentence to
 * the assistant beginning to speak.
 *
 * Supported providers:
 *   - STT: openai (Whisper), deepgram
 *   - TTS: openai, elevenlabs
 *
 * @module lib/voice-realtime
 */
import { randomUUID } from "crypto";

const DEFAULT_STT_PROVIDER = process.env.VOICE_STT_PROVIDER || "openai";
const DEFAULT_TTS_PROVIDER = process.env.VOICE_TTS_PROVIDER || "openai";
const DEFAULT_VOICE_MODEL = process.env.VOICE_MODEL || "gpt-4o-mini";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";

const VAD_SILENCE_THRESHOLD_MS = Number(process.env.VAD_SILENCE_MS || 700);
const VAD_RMS_THRESHOLD = Number(process.env.VAD_RMS_THRESHOLD || 500);
const VAD_MIN_SPEECH_MS = Number(process.env.VAD_MIN_SPEECH_MS || 200);

/** Active sessions, keyed by sessionId */
const sessions = new Map();

/**
 * Compute root-mean-square amplitude of a 16-bit PCM audio buffer.
 * Used as a simple energy-based VAD signal.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {number} RMS amplitude (0..32767)
 */
export function computeRms(buf) {
  if (!buf || buf.length < 2) return 0;
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer || buf);
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 1 < view.length; i += 2) {
    const sample = view.readInt16LE(i);
    sum += sample * sample;
    count++;
  }
  if (count === 0) return 0;
  return Math.sqrt(sum / count);
}

/**
 * Voice Activity Detection (VAD).
 * Detects speech vs. silence in a PCM audio buffer using RMS energy.
 *
 * @param {Buffer|Uint8Array} audioBuffer - 16-bit signed PCM, mono
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=16000]
 * @param {number} [opts.silenceMs=0] - Accumulated silence so far (caller-tracked)
 * @returns {Promise<{ speechDetected: boolean, endOfUtterance: boolean, silenceMs: number, rms: number }>}
 */
export async function detectEndOfSpeech(audioBuffer, opts = {}) {
  const sampleRate = Number(opts.sampleRate) || 16000;
  const prevSilenceMs = Number(opts.silenceMs) || 0;
  const rms = computeRms(audioBuffer);
  const speechDetected = rms >= VAD_RMS_THRESHOLD;

  // Each sample is 2 bytes, 1 channel.
  const sampleCount = Math.floor((audioBuffer?.length || 0) / 2);
  const chunkMs = sampleRate > 0 ? Math.round((sampleCount / sampleRate) * 1000) : 0;

  let silenceMs;
  if (speechDetected) {
    silenceMs = 0;
  } else {
    silenceMs = prevSilenceMs + chunkMs;
  }
  const endOfUtterance = !speechDetected && silenceMs >= VAD_SILENCE_THRESHOLD_MS;
  return { speechDetected, endOfUtterance, silenceMs, rms };
}

/**
 * Streaming speech-to-text. Yields partial transcripts as audio arrives.
 *
 * Accepts an async iterable of audio chunks (Buffer/Uint8Array). For
 * provider implementations this would establish a websocket to the STT
 * provider and forward audio frames; here we provide a buffered interface
 * that flushes on end-of-utterance and emits progressive partials.
 *
 * @param {AsyncIterable<Buffer>|Iterable<Buffer>} audioStream
 * @param {object} [options]
 * @param {string} [options.provider] - "openai" | "deepgram"
 * @param {string} [options.language]
 * @param {function} [options.transcribeFn] - Test/mock override
 * @returns {AsyncGenerator<{ text: string, isFinal: boolean, confidence?: number }>}
 */
export async function* streamingTranscribe(audioStream, options = {}) {
  const provider = options.provider || DEFAULT_STT_PROVIDER;
  const transcribeFn = options.transcribeFn || defaultTranscribeChunk;
  const buffer = [];
  let totalBytes = 0;

  for await (const chunk of audioStream) {
    if (!chunk || chunk.length === 0) continue;
    buffer.push(chunk);
    totalBytes += chunk.length;

    // Emit a partial transcript every ~16KB of audio (~0.5s at 16kHz mono).
    if (totalBytes >= 16 * 1024) {
      const merged = Buffer.concat(buffer);
      try {
        const partial = await transcribeFn(merged, { provider, isFinal: false, language: options.language });
        if (partial && partial.text) {
          yield { text: partial.text, isFinal: false, confidence: partial.confidence };
        }
      } catch (_) {
        // Ignore partial errors and continue accumulating.
      }
    }
  }

  if (buffer.length === 0) return;
  const merged = Buffer.concat(buffer);
  const final = await transcribeFn(merged, { provider, isFinal: true, language: options.language });
  yield { text: final?.text || "", isFinal: true, confidence: final?.confidence };
}

/**
 * Default transcribe function. In production it would call OpenAI Whisper
 * or Deepgram. In tests/dev (no API key) it returns an empty string.
 * @private
 */
async function defaultTranscribeChunk(audioBuffer, opts) {
  const provider = opts.provider || DEFAULT_STT_PROVIDER;
  if (provider === "openai" && OPENAI_API_KEY) {
    try {
      const form = new FormData();
      const blob = new Blob([audioBuffer], { type: "audio/wav" });
      form.append("file", blob, "audio.wav");
      form.append("model", "whisper-1");
      if (opts.language) form.append("language", opts.language);
      const res = await fetch(`${OPENAI_BASE_URL}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      });
      if (!res.ok) return { text: "" };
      const data = await res.json();
      return { text: data.text || "" };
    } catch (_) {
      return { text: "" };
    }
  }
  if (provider === "deepgram" && DEEPGRAM_API_KEY) {
    try {
      const res = await fetch("https://api.deepgram.com/v1/listen", {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": "audio/wav",
        },
        body: audioBuffer,
      });
      if (!res.ok) return { text: "" };
      const data = await res.json();
      const alt = data?.results?.channels?.[0]?.alternatives?.[0];
      return { text: alt?.transcript || "", confidence: alt?.confidence };
    } catch (_) {
      return { text: "" };
    }
  }
  return { text: "" };
}

/**
 * Streaming text-to-speech. Begins emitting audio chunks before the full
 * text input is consumed, so the first audio frame can play within ~200ms
 * of the first text token.
 *
 * @param {AsyncIterable<string>|Iterable<string>|string} textStream
 * @param {object} [options]
 * @param {string} [options.provider] - "openai" | "elevenlabs"
 * @param {string} [options.voice]
 * @param {string} [options.format]
 * @param {function} [options.synthesizeFn] - Test/mock override
 * @returns {AsyncGenerator<{ audio: Buffer, contentType: string, isFinal: boolean }>}
 */
export async function* streamingSynthesize(textStream, options = {}) {
  const provider = options.provider || DEFAULT_TTS_PROVIDER;
  const voice = options.voice || "alloy";
  const format = options.format || "mp3";
  const synthesizeFn = options.synthesizeFn || defaultSynthesizeChunk;

  // Normalize input to async iterable.
  let iter;
  if (typeof textStream === "string") {
    iter = (async function* () { yield textStream; })();
  } else if (Symbol.asyncIterator in Object(textStream)) {
    iter = textStream;
  } else if (Symbol.iterator in Object(textStream)) {
    iter = (async function* () { for (const t of textStream) yield t; })();
  } else {
    iter = (async function* () {})();
  }

  let pending = "";
  for await (const chunk of iter) {
    if (typeof chunk !== "string") continue;
    pending += chunk;
    // Flush at sentence boundaries to start playback ASAP.
    let boundary;
    while ((boundary = findSentenceBoundary(pending)) !== -1) {
      const sentence = pending.slice(0, boundary + 1).trim();
      pending = pending.slice(boundary + 1);
      if (sentence) {
        const audio = await synthesizeFn(sentence, { provider, voice, format });
        if (audio?.audio?.length) {
          yield { audio: audio.audio, contentType: audio.contentType || "audio/mpeg", isFinal: false };
        }
      }
    }
  }
  if (pending.trim()) {
    const audio = await synthesizeFn(pending.trim(), { provider, voice, format });
    if (audio?.audio?.length) {
      yield { audio: audio.audio, contentType: audio.contentType || "audio/mpeg", isFinal: true };
    } else {
      yield { audio: Buffer.alloc(0), contentType: "audio/mpeg", isFinal: true };
    }
  } else {
    yield { audio: Buffer.alloc(0), contentType: "audio/mpeg", isFinal: true };
  }
}

function findSentenceBoundary(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "." || c === "!" || c === "?") {
      // Require trailing space or end-of-string to avoid splitting "1.5".
      if (i === text.length - 1 || text[i + 1] === " " || text[i + 1] === "\n") return i;
    }
  }
  return -1;
}

async function defaultSynthesizeChunk(text, opts) {
  const provider = opts.provider || DEFAULT_TTS_PROVIDER;
  if (provider === "openai" && OPENAI_API_KEY) {
    try {
      const res = await fetch(`${OPENAI_BASE_URL}/v1/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice: opts.voice || "alloy",
          input: text,
          response_format: opts.format || "mp3",
        }),
      });
      if (!res.ok) return { audio: Buffer.alloc(0), contentType: "audio/mpeg" };
      const buf = Buffer.from(await res.arrayBuffer());
      return { audio: buf, contentType: "audio/mpeg" };
    } catch (_) {
      return { audio: Buffer.alloc(0), contentType: "audio/mpeg" };
    }
  }
  if (provider === "elevenlabs" && ELEVENLABS_API_KEY) {
    try {
      const voiceId = opts.voice || "21m00Tcm4TlvDq8ikWAM";
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text, model_id: "eleven_turbo_v2" }),
      });
      if (!res.ok) return { audio: Buffer.alloc(0), contentType: "audio/mpeg" };
      const buf = Buffer.from(await res.arrayBuffer());
      return { audio: buf, contentType: "audio/mpeg" };
    } catch (_) {
      return { audio: Buffer.alloc(0), contentType: "audio/mpeg" };
    }
  }
  return { audio: Buffer.alloc(0), contentType: "audio/mpeg" };
}

/**
 * Create a real-time voice session that wires together streaming STT, an LLM
 * model, and streaming TTS for full-duplex voice chat.
 *
 * @param {object} options
 * @param {string} [options.sttProvider]
 * @param {string} [options.ttsProvider]
 * @param {string} [options.model]
 * @param {string} [options.voice]
 * @param {string} [options.userId]
 * @param {string} [options.workspaceId]
 * @param {function} [options.transcribeFn] - Test/mock override
 * @param {function} [options.synthesizeFn] - Test/mock override
 * @param {function} [options.completeFn] - Test/mock for chat completion
 * @returns {object} Session controller
 */
export function createVoiceSession(options = {}) {
  const id = options.id || randomUUID();
  const sttProvider = options.sttProvider || DEFAULT_STT_PROVIDER;
  const ttsProvider = options.ttsProvider || DEFAULT_TTS_PROVIDER;
  const model = options.model || DEFAULT_VOICE_MODEL;
  const voice = options.voice || "alloy";
  const transcribeFn = options.transcribeFn || defaultTranscribeChunk;
  const synthesizeFn = options.synthesizeFn || defaultSynthesizeChunk;
  const completeFn = options.completeFn || null;

  const startedAt = Date.now();
  const stats = {
    sessionId: id,
    startedAt,
    endedAt: null,
    audioBytes: 0,
    audioSeconds: 0,
    transcriptChars: 0,
    responseChars: 0,
    turns: 0,
    latencyMs: 0,
    lastLatencies: [],
  };

  const audioBuffer = [];
  let silenceMs = 0;
  let utteranceStartedAt = null;
  let active = false;
  let onTranscriptCb = null;
  let onResponseCb = null;
  let onAudioCb = null;
  let pending = Promise.resolve();

  function recordLatency(ms) {
    stats.lastLatencies.push(ms);
    if (stats.lastLatencies.length > 20) stats.lastLatencies.shift();
    const sum = stats.lastLatencies.reduce((a, b) => a + b, 0);
    stats.latencyMs = Math.round(sum / stats.lastLatencies.length);
  }

  async function flushUtterance() {
    if (audioBuffer.length === 0) return;
    const merged = Buffer.concat(audioBuffer);
    audioBuffer.length = 0;
    const utteranceStart = utteranceStartedAt || Date.now();
    utteranceStartedAt = null;
    silenceMs = 0;

    const transcribeStart = Date.now();
    let transcript;
    try {
      transcript = await transcribeFn(merged, { provider: sttProvider, isFinal: true });
    } catch (err) {
      transcript = { text: "" };
    }
    const text = transcript?.text || "";
    if (!text) return;
    stats.transcriptChars += text.length;
    stats.turns += 1;
    if (typeof onTranscriptCb === "function") {
      try { onTranscriptCb({ text, isFinal: true, confidence: transcript.confidence }); } catch (_) {}
    }

    let responseText = "";
    if (typeof completeFn === "function") {
      try {
        const r = await completeFn(text, { model });
        responseText = typeof r === "string" ? r : (r?.text || "");
      } catch (_) {
        responseText = "";
      }
    } else {
      responseText = "";
    }
    stats.responseChars += responseText.length;
    if (typeof onResponseCb === "function") {
      try { onResponseCb({ text: responseText, isFinal: true }); } catch (_) {}
    }

    if (responseText && typeof onAudioCb === "function") {
      try {
        const audioOut = await synthesizeFn(responseText, { provider: ttsProvider, voice });
        if (audioOut?.audio) {
          onAudioCb({ audio: audioOut.audio, contentType: audioOut.contentType || "audio/mpeg", isFinal: true });
        }
      } catch (_) {}
    }

    const totalMs = Date.now() - utteranceStart;
    recordLatency(totalMs);
  }

  const session = {
    id,
    get active() { return active; },

    /**
     * Start the session and register event callbacks.
     * @param {function} onTranscript
     * @param {function} onResponse
     * @param {function} onAudio
     */
    async startSession(onTranscript, onResponse, onAudio) {
      onTranscriptCb = onTranscript || null;
      onResponseCb = onResponse || null;
      onAudioCb = onAudio || null;
      active = true;
      sessions.set(id, session);
      return { id, startedAt };
    },

    /**
     * Append an audio chunk and run VAD. When end-of-utterance is detected
     * the buffered audio is transcribed and the assistant responds.
     * @param {Buffer|Uint8Array} chunk
     */
    async sendAudioChunk(chunk) {
      if (!active) throw new Error("Session not started");
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stats.audioBytes += buf.length;
      // 16-bit mono @ 16kHz => 32000 bytes/sec
      stats.audioSeconds += buf.length / 32000;
      audioBuffer.push(buf);
      if (utteranceStartedAt == null) utteranceStartedAt = Date.now();

      const vad = await detectEndOfSpeech(buf, { silenceMs });
      silenceMs = vad.silenceMs;
      if (vad.endOfUtterance) {
        // Process this utterance asynchronously, queued so we don't overlap.
        pending = pending.then(flushUtterance).catch(() => {});
        await pending;
      }
      return { speechDetected: vad.speechDetected, endOfUtterance: vad.endOfUtterance, silenceMs };
    },

    /**
     * End the session, flushing any pending utterance.
     */
    async endSession() {
      if (!active) return stats;
      // Flush any buffered audio.
      if (audioBuffer.length > 0) {
        pending = pending.then(flushUtterance).catch(() => {});
        await pending;
      }
      active = false;
      stats.endedAt = Math.max(stats.startedAt + 1, Date.now());
      sessions.delete(id);
      return { ...stats };
    },

    getStats() {
      return {
        sessionId: id,
        startedAt: stats.startedAt,
        endedAt: stats.endedAt,
        latencyMs: stats.latencyMs,
        audioSeconds: Math.round(stats.audioSeconds * 100) / 100,
        audioBytes: stats.audioBytes,
        transcriptChars: stats.transcriptChars,
        responseChars: stats.responseChars,
        turns: stats.turns,
      };
    },
  };

  return session;
}

/**
 * Look up an active session by id.
 * @param {string} id
 * @returns {object|null}
 */
export function getVoiceSession(id) {
  return sessions.get(id) || null;
}

/**
 * Count active sessions (for metrics).
 */
export function listActiveSessions() {
  return Array.from(sessions.keys());
}

/**
 * Clear all sessions (for tests).
 */
export function _resetForTests() {
  sessions.clear();
}
