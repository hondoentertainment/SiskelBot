/**
 * Phase 54.3: Audio beyond STT — music, events, emotion classification.
 *
 * Pluggable classifier layer for audio analysis. Real ML backends can be
 * registered via registerClassifier; the default implementation is a
 * deterministic mock that hashes the audio buffer to produce stable results
 * so tests can assert without pulling in ML dependencies.
 */
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const CATEGORIES = {
  music: ["rock", "pop", "jazz", "classical", "electronic", "hiphop", "folk", "country"],
  events: ["speech", "music", "nature", "machinery", "silence", "applause", "laughter"],
  emotion: ["happy", "sad", "angry", "fear", "surprise", "neutral"],
  acoustic: ["indoor", "outdoor", "echoey", "noisy"],
};

const VALID_DOMAINS = Object.keys(CATEGORIES);
const MAX_ANALYSES = 10_000;

function analysesPath() {
  return join(getDataDir(), "audio-analyses.json");
}

function toBuffer(audioData) {
  if (audioData == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(audioData)) return audioData;
  if (audioData instanceof Uint8Array) return Buffer.from(audioData);
  if (Array.isArray(audioData)) return Buffer.from(audioData);
  if (typeof audioData === "string") return Buffer.from(audioData, "utf8");
  if (audioData && typeof audioData === "object" && audioData.buffer) {
    return toBuffer(audioData.buffer);
  }
  return Buffer.alloc(0);
}

function hashBytes(buf) {
  return createHash("sha256").update(buf).digest();
}

function hashToFloat(digest, offset = 0) {
  // Read 4 bytes at `offset` (mod length) and map to [0, 1).
  const len = digest.length;
  const i = ((offset % len) + len) % len;
  const a = digest[i];
  const b = digest[(i + 1) % len];
  const c = digest[(i + 2) % len];
  const d = digest[(i + 3) % len];
  const combined = (a << 24 >>> 0) + (b << 16) + (c << 8) + d;
  return combined / 0xffffffff;
}

/**
 * Structured analysis result. Keeps its shape stable across serializations.
 */
export class AudioAnalysis {
  constructor(data = {}) {
    this.id = data.id || `audio_${randomUUID()}`;
    this.audioId = data.audioId || null;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.duration = Number.isFinite(data.duration) ? data.duration : 0;
    this.sampleRate = Number.isFinite(data.sampleRate) ? data.sampleRate : 0;
    this.fingerprint = data.fingerprint || null;
    this.music = data.music || null;
    this.events = data.events || null;
    this.emotion = data.emotion || null;
    this.acoustic = data.acoustic || null;
    this.features = data.features || null;
    this.segments = Array.isArray(data.segments) ? data.segments : null;
    this.meta = data.meta && typeof data.meta === "object" ? data.meta : {};
  }

  toJSON() {
    return {
      id: this.id,
      audioId: this.audioId,
      createdAt: this.createdAt,
      duration: this.duration,
      sampleRate: this.sampleRate,
      fingerprint: this.fingerprint,
      music: this.music,
      events: this.events,
      emotion: this.emotion,
      acoustic: this.acoustic,
      features: this.features,
      segments: this.segments,
      meta: this.meta,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Classifier registry                                                 */
/* ------------------------------------------------------------------ */

const classifiers = new Map();

/**
 * Register a classifier for a given domain. Fn signature:
 *   (audioData, options) => { label, confidence, scores } | Promise<...>
 */
export function registerClassifier(domain, fn) {
  if (!VALID_DOMAINS.includes(domain)) {
    throw new Error(`invalid domain: ${domain}`);
  }
  if (typeof fn !== "function") {
    throw new Error("classifier fn must be a function");
  }
  classifiers.set(domain, fn);
}

export function getClassifier(domain) {
  if (!VALID_DOMAINS.includes(domain)) {
    throw new Error(`invalid domain: ${domain}`);
  }
  return classifiers.get(domain) || mockClassifier;
}

export function _clearClassifiers() {
  classifiers.clear();
}

/**
 * Deterministic mock classifier. Uses sha256 of the audio buffer to produce
 * stable label + confidence + per-category scores.
 */
export const mockClassifier = (audioData, domain) => {
  if (!VALID_DOMAINS.includes(domain)) {
    throw new Error(`invalid domain: ${domain}`);
  }
  const buf = toBuffer(audioData);
  const categories = CATEGORIES[domain];
  const digest = hashBytes(Buffer.concat([buf, Buffer.from(domain, "utf8")]));

  const rawScores = categories.map((_, i) => hashToFloat(digest, i * 4));
  const total = rawScores.reduce((a, b) => a + b, 0) || 1;
  const normalized = rawScores.map((s) => s / total);

  const scores = {};
  categories.forEach((cat, i) => {
    scores[cat] = Number(normalized[i].toFixed(6));
  });

  let bestLabel = categories[0];
  let bestScore = -Infinity;
  for (const cat of categories) {
    if (scores[cat] > bestScore) {
      bestScore = scores[cat];
      bestLabel = cat;
    }
  }

  return {
    domain,
    label: bestLabel,
    confidence: Number(bestScore.toFixed(6)),
    scores,
  };
};

async function runClassifier(domain, audioData, options = {}) {
  if (!VALID_DOMAINS.includes(domain)) {
    throw new Error(`invalid domain: ${domain}`);
  }
  const fn = classifiers.get(domain) || mockClassifier;
  const result = await fn(audioData, domain, options);
  if (!result || typeof result !== "object") {
    throw new Error(`classifier for ${domain} returned invalid result`);
  }
  return { ...result, domain };
}

export async function classifyMusic(audioData, options = {}) {
  return runClassifier("music", audioData, options);
}

export async function classifyEvents(audioData, options = {}) {
  return runClassifier("events", audioData, options);
}

export async function classifyEmotion(audioData, options = {}) {
  return runClassifier("emotion", audioData, options);
}

export async function classifyAcoustic(audioData, options = {}) {
  return runClassifier("acoustic", audioData, options);
}

/* ------------------------------------------------------------------ */
/* Feature extraction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compute basic statistics from the raw audio bytes. In a real system these
 * would be proper DSP features (MFCC, ZCR, RMS, spectral centroid); the stub
 * computes analogous deterministic signals from the byte stream so tests and
 * downstream code see a stable shape.
 */
export function extractFeatures(audioData) {
  const buf = toBuffer(audioData);
  const n = buf.length;
  if (n === 0) {
    return { mfcc: [], zcr: 0, rms: 0, spectralCentroid: 0, length: 0 };
  }

  let sumSq = 0;
  let zeroCrossings = 0;
  let prevCentered = 0;
  let weighted = 0;
  let magSum = 0;

  for (let i = 0; i < n; i++) {
    const v = buf[i] - 128; // center around zero
    sumSq += v * v;
    if (i > 0 && Math.sign(v) !== Math.sign(prevCentered)) {
      zeroCrossings++;
    }
    prevCentered = v;
    const mag = Math.abs(v);
    weighted += i * mag;
    magSum += mag;
  }

  const rms = Math.sqrt(sumSq / n) / 128;
  const zcr = zeroCrossings / Math.max(1, n - 1);
  const spectralCentroid = magSum > 0 ? weighted / magSum / n : 0;

  // 13 mock MFCC coefficients derived from byte bucket averages.
  const mfcc = [];
  const buckets = 13;
  const step = Math.max(1, Math.floor(n / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * step;
    const end = Math.min(n, start + step);
    let sum = 0;
    for (let i = start; i < end; i++) sum += buf[i];
    const avg = end > start ? sum / (end - start) : 0;
    mfcc.push(Number(((avg - 128) / 128).toFixed(6)));
  }

  return {
    mfcc,
    zcr: Number(zcr.toFixed(6)),
    rms: Number(rms.toFixed(6)),
    spectralCentroid: Number(spectralCentroid.toFixed(6)),
    length: n,
  };
}

/**
 * Stable fingerprint: sha256 over length + first/last 1024 bytes.
 */
export function computeAudioFingerprint(audioData) {
  const buf = toBuffer(audioData);
  const header = buf.subarray(0, Math.min(1024, buf.length));
  const footer = buf.subarray(Math.max(0, buf.length - 1024));
  const h = createHash("sha256");
  h.update(Buffer.from(String(buf.length)));
  h.update(header);
  h.update(footer);
  return h.digest("hex");
}

/* ------------------------------------------------------------------ */
/* Top-level analysis                                                  */
/* ------------------------------------------------------------------ */

function estimateDurationMs(buf, sampleRate = 16000) {
  // Assume 16-bit mono PCM unless caller overrides: bytes / (sr * 2) seconds.
  if (!buf.length || !sampleRate) return 0;
  return Math.round((buf.length / (sampleRate * 2)) * 1000);
}

/**
 * Run all enabled domains against a single audio buffer.
 *
 * options.domains: subset of VALID_DOMAINS (default: all)
 * options.sampleRate: assumed sample rate when estimating duration
 * options.duration: explicit duration in ms (skips estimate)
 * options.audioId: optional external id for persistence
 */
export async function analyzeAudio(audioData, options = {}) {
  const buf = toBuffer(audioData);
  const sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : 16000;
  const duration = Number.isFinite(options.duration)
    ? options.duration
    : estimateDurationMs(buf, sampleRate);

  const requested = Array.isArray(options.domains) && options.domains.length > 0
    ? options.domains
    : VALID_DOMAINS;
  for (const d of requested) {
    if (!VALID_DOMAINS.includes(d)) {
      throw new Error(`invalid domain: ${d}`);
    }
  }

  const result = {
    music: null,
    events: null,
    emotion: null,
    acoustic: null,
    duration,
    sampleRate,
  };

  for (const domain of requested) {
    result[domain] = await runClassifier(domain, buf, options);
  }

  const analysis = new AudioAnalysis({
    audioId: options.audioId || null,
    duration,
    sampleRate,
    fingerprint: computeAudioFingerprint(buf),
    music: result.music,
    events: result.events,
    emotion: result.emotion,
    acoustic: result.acoustic,
    features: options.includeFeatures ? extractFeatures(buf) : null,
    meta: options.meta && typeof options.meta === "object" ? options.meta : {},
  });

  return analysis.toJSON();
}

/**
 * Segment-level analysis: splits the buffer into fixed-duration chunks and
 * runs analyzeAudio on each. Segment duration is measured in milliseconds.
 */
export async function analyzeSegments(audioData, segmentDurationMs = 1000, options = {}) {
  const buf = toBuffer(audioData);
  const sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : 16000;
  const bytesPerMs = (sampleRate * 2) / 1000;
  const bytesPerSegment = Math.max(1, Math.floor(bytesPerMs * segmentDurationMs));

  if (buf.length === 0) return [];

  const segments = [];
  let offset = 0;
  let index = 0;
  while (offset < buf.length) {
    const end = Math.min(buf.length, offset + bytesPerSegment);
    const chunk = buf.subarray(offset, end);
    const startMs = Math.round(offset / bytesPerMs);
    const endMs = Math.round(end / bytesPerMs);
    const analysis = await analyzeAudio(chunk, {
      ...options,
      sampleRate,
      duration: endMs - startMs,
    });
    segments.push({
      index,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      analysis,
    });
    offset = end;
    index++;
  }
  return segments;
}

/**
 * Detect events across a stream of chunks, producing timestamped labels.
 * chunks: Array<Buffer|Uint8Array|string>
 * options.sampleRate, options.startMs
 */
export async function detectEventsInStream(chunks, options = {}) {
  if (!Array.isArray(chunks)) return [];
  const sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : 16000;
  const bytesPerMs = (sampleRate * 2) / 1000;

  let cursorMs = Number.isFinite(options.startMs) ? options.startMs : 0;
  const results = [];
  for (const raw of chunks) {
    const buf = toBuffer(raw);
    if (buf.length === 0) continue;
    const durationMs = Math.max(1, Math.round(buf.length / bytesPerMs));
    const { label, confidence, scores } = await runClassifier("events", buf, options);
    results.push({
      timestampMs: cursorMs,
      durationMs,
      event: label,
      confidence,
      scores,
    });
    cursorMs += durationMs;
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

async function loadAnalyses() {
  const data = await readJsonPath(analysesPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function persistAnalyses(items) {
  const trimmed = items.length > MAX_ANALYSES ? items.slice(-MAX_ANALYSES) : items;
  await writeJsonPath(analysesPath(), { _version: 1, items: trimmed });
}

/**
 * Save an analysis (plain object or AudioAnalysis instance) indexed by audioId.
 */
export async function saveAnalysis(audioId, analysis) {
  if (!audioId || typeof audioId !== "string") {
    throw new Error("audioId is required");
  }
  if (!analysis || typeof analysis !== "object") {
    throw new Error("analysis is required");
  }
  const payload = analysis instanceof AudioAnalysis ? analysis.toJSON() : analysis;
  const record = {
    ...payload,
    audioId,
    savedAt: new Date().toISOString(),
  };
  if (!record.id) record.id = `audio_${randomUUID()}`;

  const path = analysesPath();
  await withPathLock(path, async () => {
    const items = await loadAnalyses();
    const filtered = items.filter((entry) => entry.audioId !== audioId);
    filtered.push(record);
    await persistAnalyses(filtered);
  });
  return record;
}

export async function getAnalysis(audioId) {
  if (!audioId || typeof audioId !== "string") return null;
  const items = await loadAnalyses();
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].audioId === audioId) return items[i];
  }
  return null;
}

/**
 * List stored analyses, optionally filtered by fields.
 * filter: { audioId?, musicLabel?, emotionLabel?, eventLabel?, acousticLabel?, since?, until? }
 */
export async function listAnalyses(filter = {}) {
  const items = await loadAnalyses();
  return items.filter((entry) => {
    if (filter.audioId && entry.audioId !== filter.audioId) return false;
    if (filter.musicLabel && entry.music?.label !== filter.musicLabel) return false;
    if (filter.emotionLabel && entry.emotion?.label !== filter.emotionLabel) return false;
    if (filter.eventLabel && entry.events?.label !== filter.eventLabel) return false;
    if (filter.acousticLabel && entry.acoustic?.label !== filter.acousticLabel) return false;
    if (filter.since && entry.createdAt && entry.createdAt < filter.since) return false;
    if (filter.until && entry.createdAt && entry.createdAt > filter.until) return false;
    return true;
  });
}

export async function _resetAnalyses() {
  await persistAnalyses([]);
}

export function _validDomains() {
  return VALID_DOMAINS.slice();
}
