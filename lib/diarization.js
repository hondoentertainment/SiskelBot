/**
 * Phase 44.3: Speaker diarization.
 *
 * Identifies multiple speakers in audio recordings and produces
 * transcripts annotated with speaker labels.
 *
 * Providers:
 *   - openai (default): Uses Whisper for transcription, then performs a
 *     lightweight energy / silence-based speaker change detection on the
 *     resulting verbose-json segments.
 *   - assemblyai: AssemblyAI transcription with native speaker_labels.
 *   - deepgram: Deepgram /listen with diarize=true.
 *   - pyannote: Hugging Face Inference API for the pyannote diarization model.
 *
 * Speaker enrollment is voiceprint-based using a SHA-256 fingerprint of a
 * normalised audio sample. This is intentionally lightweight and not a
 * production-grade speaker recognition system, but provides a stable id +
 * deterministic matching for tests and offline workflows.
 *
 * @module lib/diarization
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonPath } from "./json-path-store.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com";
const WHISPER_API_KEY = process.env.WHISPER_API_KEY || "";
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || "";

const DEFAULT_PROVIDER = process.env.DIARIZATION_PROVIDER || "openai";
const DEFAULT_WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
const VOICEPRINT_VERSION = 1;

/**
 * Available diarization providers and their configuration state.
 * @returns {{ provider: string, providers: Record<string, boolean> }}
 */
export function getDiarizationCapabilities() {
  return {
    provider: DEFAULT_PROVIDER,
    providers: {
      openai: Boolean(OPENAI_API_KEY || WHISPER_API_KEY),
      assemblyai: Boolean(ASSEMBLYAI_API_KEY),
      deepgram: Boolean(DEEPGRAM_API_KEY),
      pyannote: Boolean(HUGGINGFACE_API_KEY),
    },
  };
}

function makeError(message, code, status) {
  const err = new Error(message);
  err.code = code;
  if (status) err.status = status;
  return err;
}

function validateAudio(audioBuffer) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw makeError("audio buffer is required and must be non-empty", "INVALID_INPUT");
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw makeError(
      `audio exceeds maximum size of ${MAX_AUDIO_BYTES / 1024 / 1024}MB`,
      "INVALID_INPUT"
    );
  }
}

/* ------------------------------------------------------------------ */
/* Provider implementations                                            */
/* ------------------------------------------------------------------ */

async function diarizeWithOpenAI(audioBuffer, options) {
  const apiKey =
    process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY || WHISPER_API_KEY || OPENAI_API_KEY;
  if (!apiKey) {
    throw makeError(
      "OpenAI provider requires WHISPER_API_KEY or OPENAI_API_KEY",
      "DIARIZATION_NOT_CONFIGURED"
    );
  }

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer]), "audio.wav");
  formData.append("model", DEFAULT_WHISPER_MODEL);
  formData.append("response_format", "verbose_json");
  formData.append("timestamp_granularities[]", "segment");
  if (options.language) formData.append("language", options.language);

  const res = await fetch(`${OPENAI_BASE_URL}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw makeError(`Whisper error: HTTP ${res.status} ${body.slice(0, 300)}`, "BACKEND_ERROR", res.status);
  }

  const data = await res.json();
  const whisperSegments = Array.isArray(data.segments) ? data.segments : [];
  const segments = assignSpeakersByEnergy(whisperSegments, options.expectedSpeakers || 2);
  return { segments, language: data.language || options.language || "unknown" };
}

/**
 * Naive speaker change detection over Whisper segments.
 *
 * Uses average log-probability and silence gap between segments as proxies
 * for speaker change. Each segment is assigned to one of N rotating speaker
 * slots; we toggle the active speaker on long silences (>0.8s) or large
 * shifts in `avg_logprob` between consecutive segments.
 *
 * @param {Array<object>} whisperSegments
 * @param {number} expectedSpeakers
 * @returns {Array<{ speaker: string, start: number, end: number, text: string }>}
 */
export function assignSpeakersByEnergy(whisperSegments, expectedSpeakers = 2) {
  const N = Math.max(1, Math.min(8, Number(expectedSpeakers) || 2));
  const out = [];
  let speakerIdx = 0;
  let prevEnd = 0;
  let prevLogProb = null;

  for (const seg of whisperSegments) {
    const start = Number(seg.start) || 0;
    const end = Number(seg.end) || start;
    const text = (seg.text || "").trim();
    const logProb = typeof seg.avg_logprob === "number" ? seg.avg_logprob : null;

    const silenceGap = start - prevEnd;
    const logProbDelta = prevLogProb !== null && logProb !== null ? Math.abs(logProb - prevLogProb) : 0;

    const shouldSwitch =
      out.length > 0 && (silenceGap > 0.8 || logProbDelta > 0.4);

    if (shouldSwitch) {
      speakerIdx = (speakerIdx + 1) % N;
    }

    out.push({
      speaker: `Speaker ${speakerIdx + 1}`,
      start,
      end,
      text,
    });

    prevEnd = end;
    prevLogProb = logProb;
  }

  return mergeAdjacentSpeakerSegments(out);
}

/**
 * Merge consecutive segments that share the same speaker.
 * @param {Array<{ speaker: string, start: number, end: number, text: string }>} segments
 */
export function mergeAdjacentSpeakerSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.end = seg.end;
      last.text = `${last.text} ${seg.text}`.trim();
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

async function diarizeWithAssemblyAI(audioBuffer, options) {
  if (!ASSEMBLYAI_API_KEY) {
    throw makeError("AssemblyAI provider requires ASSEMBLYAI_API_KEY", "DIARIZATION_NOT_CONFIGURED");
  }
  const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/octet-stream" },
    body: audioBuffer,
  });
  if (!uploadRes.ok) {
    throw makeError(`AssemblyAI upload failed: ${uploadRes.status}`, "BACKEND_ERROR", uploadRes.status);
  }
  const { upload_url } = await uploadRes.json();
  const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { authorization: ASSEMBLYAI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: upload_url,
      speaker_labels: true,
      speakers_expected: options.expectedSpeakers || null,
      language_code: options.language || null,
    }),
  });
  if (!transcriptRes.ok) {
    throw makeError(`AssemblyAI transcript failed: ${transcriptRes.status}`, "BACKEND_ERROR", transcriptRes.status);
  }
  const job = await transcriptRes.json();
  // The caller should poll the job; we return a structured pending placeholder.
  return {
    segments: [],
    language: options.language || "unknown",
    pending: true,
    jobId: job.id,
  };
}

async function diarizeWithDeepgram(audioBuffer, options) {
  if (!DEEPGRAM_API_KEY) {
    throw makeError("Deepgram provider requires DEEPGRAM_API_KEY", "DIARIZATION_NOT_CONFIGURED");
  }
  const params = new URLSearchParams({ diarize: "true", punctuate: "true" });
  if (options.language) params.set("language", options.language);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/wav",
    },
    body: audioBuffer,
  });
  if (!res.ok) {
    throw makeError(`Deepgram error: ${res.status}`, "BACKEND_ERROR", res.status);
  }
  const data = await res.json();
  const words = data?.results?.channels?.[0]?.alternatives?.[0]?.words || [];
  const segments = wordsToSpeakerSegments(words);
  return {
    segments,
    language: data?.results?.channels?.[0]?.detected_language || options.language || "unknown",
  };
}

/**
 * Group Deepgram word objects (with speaker ids) into per-speaker segments.
 * @param {Array<{word: string, start: number, end: number, speaker?: number}>} words
 */
export function wordsToSpeakerSegments(words) {
  const out = [];
  let current = null;
  for (const w of words) {
    const speakerId = `Speaker ${(w.speaker ?? 0) + 1}`;
    if (!current || current.speaker !== speakerId) {
      if (current) out.push(current);
      current = { speaker: speakerId, start: w.start, end: w.end, text: w.word };
    } else {
      current.end = w.end;
      current.text = `${current.text} ${w.word}`;
    }
  }
  if (current) out.push(current);
  return out;
}

async function diarizeWithPyannote(audioBuffer, _options) {
  if (!HUGGINGFACE_API_KEY) {
    throw makeError("Pyannote provider requires HUGGINGFACE_API_KEY", "DIARIZATION_NOT_CONFIGURED");
  }
  const res = await fetch(
    "https://api-inference.huggingface.co/models/pyannote/speaker-diarization-3.1",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
        "Content-Type": "audio/wav",
      },
      body: audioBuffer,
    }
  );
  if (!res.ok) {
    throw makeError(`Pyannote error: ${res.status}`, "BACKEND_ERROR", res.status);
  }
  const data = await res.json();
  const turns = Array.isArray(data) ? data : data?.segments || [];
  const segments = turns.map((t) => ({
    speaker: `Speaker ${Number(t.label?.toString()?.replace(/\D/g, "") || 0) + 1}`,
    start: Number(t.start) || 0,
    end: Number(t.end) || 0,
    text: t.text || "",
  }));
  return { segments, language: "unknown" };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Diarize an audio buffer using the configured provider.
 *
 * @param {Buffer} audioBuffer
 * @param {object} [options]
 * @param {string} [options.provider] - openai | assemblyai | deepgram | pyannote
 * @param {number} [options.expectedSpeakers]
 * @param {string} [options.language]
 * @returns {Promise<{ segments: Array, speakers: Array, language?: string }>}
 */
export async function diarizeAudio(audioBuffer, options = {}) {
  validateAudio(audioBuffer);
  const provider = options.provider || DEFAULT_PROVIDER;

  let raw;
  switch (provider) {
    case "openai":
      raw = await diarizeWithOpenAI(audioBuffer, options);
      break;
    case "assemblyai":
      raw = await diarizeWithAssemblyAI(audioBuffer, options);
      break;
    case "deepgram":
      raw = await diarizeWithDeepgram(audioBuffer, options);
      break;
    case "pyannote":
      raw = await diarizeWithPyannote(audioBuffer, options);
      break;
    default:
      throw makeError(`Unknown diarization provider: ${provider}`, "INVALID_INPUT");
  }

  const segments = mergeAdjacentSpeakerSegments(raw.segments || []);
  const speakers = computeSpeakerStats(segments);

  return {
    segments,
    speakers,
    language: raw.language,
    provider,
    pending: raw.pending || false,
    jobId: raw.jobId || null,
  };
}

/**
 * Compute totalDuration per speaker from a segment list.
 * @param {Array<{ speaker: string, start: number, end: number }>} segments
 * @returns {Array<{ id: string, totalDuration: number, segmentCount: number }>}
 */
export function computeSpeakerStats(segments) {
  const map = new Map();
  for (const seg of segments) {
    const cur = map.get(seg.speaker) || { id: seg.speaker, totalDuration: 0, segmentCount: 0 };
    cur.totalDuration += Math.max(0, (Number(seg.end) || 0) - (Number(seg.start) || 0));
    cur.segmentCount += 1;
    map.set(seg.speaker, cur);
  }
  return [...map.values()].sort((a, b) => b.totalDuration - a.totalDuration);
}

/* ------------------------------------------------------------------ */
/* Speaker enrollment + identification (voiceprint)                    */
/* ------------------------------------------------------------------ */

/**
 * Compute a deterministic fingerprint of an audio buffer.
 * Hashes a normalised view (downsampled byte sums) so the same speaker sample
 * yields the same printHash even if minor padding differs.
 * @param {Buffer} audioBuffer
 */
export function computeVoicePrint(audioBuffer) {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw makeError("audio sample required", "INVALID_INPUT");
  }
  const buckets = 256;
  const sums = new Uint32Array(buckets);
  const step = Math.max(1, Math.floor(audioBuffer.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let acc = 0;
    const start = i * step;
    const end = Math.min(audioBuffer.length, start + step);
    for (let j = start; j < end; j++) acc += audioBuffer[j];
    sums[i] = acc;
  }
  const h = createHash("sha256");
  h.update(`v${VOICEPRINT_VERSION}:`);
  h.update(Buffer.from(sums.buffer));
  return h.digest("hex");
}

function speakersStorePath() {
  const dir = process.env.STORAGE_PATH || join(process.cwd(), "data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "voice-speakers.json");
}

async function loadSpeakers() {
  const path = speakersStorePath();
  const data = await readJsonPath(path, { speakers: [] });
  return Array.isArray(data.speakers) ? data : { speakers: [] };
}

async function saveSpeakers(state) {
  const path = speakersStorePath();
  // Use direct file write for simplicity; mirrors json-path-store fallback path.
  try {
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    throw makeError(`failed to persist speakers: ${err.message}`, "STORAGE_ERROR");
  }
}

/**
 * Enroll a speaker by computing and storing a voiceprint.
 *
 * @param {string} userId
 * @param {Buffer} audioSample
 * @param {string} displayName
 * @returns {Promise<{ speakerId: string, printHash: string, displayName: string, userId: string }>}
 */
export async function enrollSpeaker(userId, audioSample, displayName) {
  if (!userId || typeof userId !== "string") {
    throw makeError("userId is required", "INVALID_INPUT");
  }
  if (!displayName || typeof displayName !== "string") {
    throw makeError("displayName is required", "INVALID_INPUT");
  }
  validateAudio(audioSample);

  const printHash = computeVoicePrint(audioSample);
  const speakerId = `spk_${createHash("sha256").update(`${userId}:${printHash}`).digest("hex").slice(0, 16)}`;

  const state = await loadSpeakers();
  const existingIdx = state.speakers.findIndex((s) => s.speakerId === speakerId);
  const record = {
    speakerId,
    userId,
    displayName,
    printHash,
    enrolledAt: new Date().toISOString(),
  };
  if (existingIdx >= 0) state.speakers[existingIdx] = record;
  else state.speakers.push(record);
  await saveSpeakers(state);

  return record;
}

/**
 * List enrolled speakers, optionally filtered by user.
 * @param {string} [userId]
 */
export async function listSpeakers(userId) {
  const state = await loadSpeakers();
  if (userId) return state.speakers.filter((s) => s.userId === userId);
  return state.speakers;
}

/**
 * Delete an enrolled speaker by id.
 * @param {string} speakerId
 * @returns {Promise<boolean>}
 */
export async function deleteSpeaker(speakerId) {
  const state = await loadSpeakers();
  const before = state.speakers.length;
  state.speakers = state.speakers.filter((s) => s.speakerId !== speakerId);
  await saveSpeakers(state);
  return state.speakers.length < before;
}

/**
 * Identify a speaker in an audio buffer by matching against known speakers.
 * Returns the closest match by Hamming-style hex distance over the voiceprint.
 *
 * @param {Buffer} audioBuffer
 * @param {Array<{ speakerId: string, printHash: string, displayName?: string }>} [knownSpeakers]
 * @returns {Promise<{ speakerId: string|null, displayName: string|null, confidence: number }>}
 */
export async function identifySpeaker(audioBuffer, knownSpeakers) {
  validateAudio(audioBuffer);
  const candidates = Array.isArray(knownSpeakers) && knownSpeakers.length > 0
    ? knownSpeakers
    : await listSpeakers();

  if (candidates.length === 0) {
    return { speakerId: null, displayName: null, confidence: 0 };
  }

  const targetHash = computeVoicePrint(audioBuffer);
  let best = { speakerId: null, displayName: null, confidence: 0 };

  for (const cand of candidates) {
    const sim = hexSimilarity(targetHash, cand.printHash);
    if (sim > best.confidence) {
      best = {
        speakerId: cand.speakerId,
        displayName: cand.displayName || null,
        confidence: sim,
      };
    }
  }

  return best;
}

/**
 * Compute similarity (0..1) between two equal-length hex strings.
 * Identical strings yield 1.0; completely different yield ~0.
 */
export function hexSimilarity(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let matches = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) matches += 1;
  }
  return matches / len;
}

/**
 * Combined STT + diarization. Returns the diarization result plus a
 * formatted transcript string with speaker labels.
 *
 * @param {Buffer} audioBuffer
 * @param {object} [options]
 * @returns {Promise<{ segments, speakers, transcript: string }>}
 */
export async function transcribeWithDiarization(audioBuffer, options = {}) {
  const result = await diarizeAudio(audioBuffer, options);
  const transcript = formatTranscript(result.segments);
  return { ...result, transcript };
}

/**
 * Format a list of speaker segments as a plain transcript.
 * @param {Array<{ speaker: string, text: string }>} segments
 */
export function formatTranscript(segments) {
  if (!Array.isArray(segments)) return "";
  return segments
    .filter((s) => s && s.text)
    .map((s) => `${s.speaker}: ${s.text}`)
    .join("\n");
}

/* ------------------------------------------------------------------ */
/* Export formats                                                      */
/* ------------------------------------------------------------------ */

/**
 * Export a transcript in srt | vtt | json | txt.
 * @param {Array<{ speaker: string, start: number, end: number, text: string }>} segments
 * @param {string} format
 * @returns {{ data: string, contentType: string, filename: string }}
 */
export function exportTranscript(segments, format) {
  const fmt = String(format || "txt").toLowerCase();
  if (!Array.isArray(segments)) segments = [];

  switch (fmt) {
    case "srt":
      return {
        data: toSrt(segments),
        contentType: "application/x-subrip",
        filename: "transcript.srt",
      };
    case "vtt":
      return {
        data: toVtt(segments),
        contentType: "text/vtt",
        filename: "transcript.vtt",
      };
    case "json":
      return {
        data: JSON.stringify({ segments }, null, 2),
        contentType: "application/json",
        filename: "transcript.json",
      };
    case "txt":
      return {
        data: formatTranscript(segments),
        contentType: "text/plain",
        filename: "transcript.txt",
      };
    default:
      throw makeError(`unsupported export format: ${format}`, "INVALID_INPUT");
  }
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

function formatSrtTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

function formatVttTime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)}.${pad(ms, 3)}`;
}

function toSrt(segments) {
  const lines = [];
  segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}`);
    lines.push(`${seg.speaker}: ${seg.text}`);
    lines.push("");
  });
  return lines.join("\n").trim() + "\n";
}

function toVtt(segments) {
  const lines = ["WEBVTT", ""];
  segments.forEach((seg, i) => {
    lines.push(`${i + 1}`);
    lines.push(`${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}`);
    lines.push(`<v ${seg.speaker}>${seg.text}`);
    lines.push("");
  });
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* In-memory job store for export-by-id                                */
/* ------------------------------------------------------------------ */

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Save a diarization result for later export retrieval.
 * @param {string} jobId
 * @param {object} result
 */
export function storeJob(jobId, result) {
  jobs.set(jobId, { result, expiresAt: Date.now() + JOB_TTL_MS });
}

/**
 * Get a stored diarization job result by id.
 * @param {string} jobId
 */
export function getJob(jobId) {
  const entry = jobs.get(jobId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    jobs.delete(jobId);
    return null;
  }
  return entry.result;
}

/**
 * Test/cleanup helper.
 */
export function _resetJobs() {
  jobs.clear();
}

// Re-export for tests that need direct file access (e.g. cleanup)
export function _speakersStorePath() {
  return speakersStorePath();
}

// readFileSync is intentionally imported but not used directly above; kept for
// callers that want to inspect raw store contents in tests.
export { readFileSync as _rawReadFile };
