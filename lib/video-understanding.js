/**
 * Phase 54.1: Video understanding — frame sampling + temporal reasoning pipeline.
 *
 * Since SiskelBot has no FFmpeg/ML dependencies, this module provides a
 * metadata/abstraction layer that accepts frames as base64 images and
 * computes temporal features on them. Actual frame extraction is delegated
 * to a pluggable `frameExtractor` (stubbed by default).
 *
 * Storage layout:
 *   data/video-understanding/analyses.json
 *     { _version, items: [ { videoId, workspaceId, analysis, createdAt } ] }
 *
 * Exports:
 *   - VideoMetadata, sampleFrames, registerFrameExtractor, getFrameExtractor
 *   - stubFrameExtractor
 *   - detectSceneChanges, detectMotion, computeKeyframes
 *   - analyzeVideo, generateVideoSummary
 *   - analyzeFrame, registerFrameAnalyzer
 *   - saveVideoAnalysis, getVideoAnalysis, listVideoAnalyses
 *   - frameHash, hashDistance
 */
import crypto from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_ANALYSES = 5_000;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function analysesPath() {
  return join(getDataDir(), "video-understanding", "analyses.json");
}

async function loadAnalyses() {
  const data = await readJsonPath(analysesPath(), { _version: 1, items: [] });
  return Array.isArray(data.items) ? data.items : [];
}

async function saveAnalyses(items) {
  const trimmed = items.length > MAX_ANALYSES ? items.slice(-MAX_ANALYSES) : items;
  await writeJsonPath(analysesPath(), { _version: 1, items: trimmed });
}

// ---------------------------------------------------------------------------
// VideoMetadata
// ---------------------------------------------------------------------------

export class VideoMetadata {
  constructor({
    duration = 0,
    fps = 0,
    width = 0,
    height = 0,
    frameCount = 0,
    codec = "",
    format = "",
  } = {}) {
    this.duration = Number(duration) || 0;
    this.fps = Number(fps) || 0;
    this.width = Number(width) || 0;
    this.height = Number(height) || 0;
    this.frameCount = Number(frameCount) || 0;
    this.codec = String(codec || "");
    this.format = String(format || "");
  }

  toJSON() {
    return {
      duration: this.duration,
      fps: this.fps,
      width: this.width,
      height: this.height,
      frameCount: this.frameCount,
      codec: this.codec,
      format: this.format,
    };
  }
}

// ---------------------------------------------------------------------------
// Pluggable frame extractors
// ---------------------------------------------------------------------------

const frameExtractors = new Map();

export function registerFrameExtractor(name, fn) {
  if (!name || typeof name !== "string") {
    throw new Error("registerFrameExtractor: name required");
  }
  if (typeof fn !== "function") {
    throw new Error("registerFrameExtractor: fn must be a function");
  }
  frameExtractors.set(name, fn);
}

export function getFrameExtractor(name) {
  return frameExtractors.get(name) || null;
}

/**
 * Stub frame extractor. Returns deterministic fake frames so tests don't need
 * FFmpeg. Each frame's base64 payload is derived from the frame index so that
 * adjacent frames produce recognisable content (useful for motion/scene tests).
 */
export const stubFrameExtractor = async (video, options = {}) => {
  const count = Math.max(1, Math.min(512, Number(options.count) || 8));
  const duration = Number(video?.metadata?.duration) || 10;
  const startMs = Math.max(0, Number(options.startMs) || 0);
  const endMs = Math.min(duration * 1000, Number(options.endMs) || duration * 1000);
  const span = Math.max(1, endMs - startMs);

  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? startMs : startMs + (i * span) / (count - 1);
    // Deterministic pseudo-image content: the first byte encodes a "scene"
    // index so that detectSceneChanges can find boundaries in tests.
    const sceneIdx = Math.floor((i * 4) / count);
    const bytes = Buffer.alloc(32);
    bytes[0] = sceneIdx * 64;
    bytes[1] = i;
    for (let k = 2; k < bytes.length; k++) bytes[k] = (i * 17 + k * 31) % 256;
    frames.push({
      frameIndex: i,
      timestampMs: Math.round(t),
      dataBase64: bytes.toString("base64"),
    });
  }
  return frames;
};

registerFrameExtractor("stub", stubFrameExtractor);

// ---------------------------------------------------------------------------
// sampleFrames
// ---------------------------------------------------------------------------

/**
 * Sample frames from a video using a pluggable extractor. Video may be an
 * object with { url, metadata, frames? }. If `frames` is already populated,
 * they are used directly (subject to count/start/end filtering) rather than
 * calling an extractor. This lets callers pre-extract frames with their own
 * tooling.
 */
export async function sampleFrames(video, options = {}) {
  if (!video || typeof video !== "object") {
    throw new Error("sampleFrames: video is required");
  }
  const strategy = options.strategy || "uniform";
  const count = Math.max(1, Math.min(512, Number(options.count) || 8));
  const startMs = Number.isFinite(options.startMs) ? Math.max(0, options.startMs) : 0;
  const endMs = Number.isFinite(options.endMs) ? options.endMs : undefined;

  // Direct frame input path
  if (Array.isArray(video.frames) && video.frames.length > 0) {
    let src = video.frames.filter((f) => {
      if (!f || typeof f !== "object") return false;
      const t = Number(f.timestampMs) || 0;
      if (t < startMs) return false;
      if (endMs != null && t > endMs) return false;
      return true;
    });

    if (strategy === "keyframes") {
      src = src.filter((f) => f.isKeyframe === true || src.length <= count);
    }

    if (src.length <= count) {
      return src.map((f, i) => normalizeFrame(f, i));
    }

    if (strategy === "uniform") {
      const step = src.length / count;
      const out = [];
      for (let i = 0; i < count; i++) {
        out.push(normalizeFrame(src[Math.floor(i * step)], i));
      }
      return out;
    }

    if (strategy === "adaptive") {
      // Adaptive: bias towards frames with higher internal variance (hash).
      const scored = src.map((f, i) => ({
        frame: f,
        score: scoreFrameVariance(f),
        idx: i,
      }));
      scored.sort((a, b) => b.score - a.score);
      const picked = scored.slice(0, count).sort((a, b) => a.idx - b.idx);
      return picked.map((p, i) => normalizeFrame(p.frame, i));
    }

    // Fallback — uniform
    const step = src.length / count;
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(normalizeFrame(src[Math.floor(i * step)], i));
    }
    return out;
  }

  // Otherwise use extractor
  const extractorName = options.extractor || video.extractor || "stub";
  const extractor = getFrameExtractor(extractorName);
  if (!extractor) {
    throw new Error(`sampleFrames: unknown extractor ${extractorName}`);
  }
  const frames = await extractor(video, { ...options, count, startMs, endMs });
  return (frames || []).map((f, i) => normalizeFrame(f, i));
}

function normalizeFrame(f, idx) {
  return {
    frameIndex: Number.isFinite(f.frameIndex) ? f.frameIndex : idx,
    timestampMs: Number.isFinite(f.timestampMs) ? f.timestampMs : 0,
    dataBase64: typeof f.dataBase64 === "string" ? f.dataBase64 : "",
  };
}

function scoreFrameVariance(f) {
  if (!f || typeof f.dataBase64 !== "string") return 0;
  const buf = safeBase64ToBuffer(f.dataBase64);
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const mean = sum / buf.length;
  let variance = 0;
  for (let i = 0; i < buf.length; i++) {
    const d = buf[i] - mean;
    variance += d * d;
  }
  return variance / buf.length;
}

function safeBase64ToBuffer(b64) {
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------
// Frame hashing (simple pHash-like)
// ---------------------------------------------------------------------------

/**
 * Produce a 64-bit perceptual hash string of a frame's base64 bytes. We avoid
 * a real DCT (which would need a PNG/JPEG decoder) and instead compute a
 * stable bit-fingerprint based on 64 rolling block means above/below the
 * global mean. That's sufficient for the temporal heuristics used below.
 */
export function frameHash(frameData) {
  const input = typeof frameData === "string" ? frameData : frameData?.dataBase64 || "";
  const buf = safeBase64ToBuffer(input);
  if (!buf.length) return "0".repeat(16);

  const blocks = 64;
  const blockSize = Math.max(1, Math.floor(buf.length / blocks));
  const means = new Array(blocks).fill(0);
  let total = 0;
  let count = 0;

  for (let b = 0; b < blocks; b++) {
    const start = b * blockSize;
    const end = Math.min(buf.length, start + blockSize);
    let sum = 0;
    const len = Math.max(1, end - start);
    for (let i = start; i < end; i++) sum += buf[i];
    means[b] = sum / len;
    total += means[b] * len;
    count += len;
  }
  const globalMean = count ? total / count : 0;

  let bits = "";
  for (let b = 0; b < blocks; b++) bits += means[b] >= globalMean ? "1" : "0";

  // Convert 64 bits into 16 hex chars
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

export function hashDistance(h1, h2) {
  if (!h1 || !h2) return 64;
  const a = String(h1);
  const b = String(h2);
  const len = Math.max(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    const av = parseInt(a[i] || "0", 16);
    const bv = parseInt(b[i] || "0", 16);
    let x = av ^ bv;
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Pluggable frame analyzers
// ---------------------------------------------------------------------------

const frameAnalyzers = new Map();

export function registerFrameAnalyzer(name, fn) {
  if (!name || typeof name !== "string") {
    throw new Error("registerFrameAnalyzer: name required");
  }
  if (typeof fn !== "function") {
    throw new Error("registerFrameAnalyzer: fn must be a function");
  }
  frameAnalyzers.set(name, fn);
}

function defaultFrameAnalyzer(frameData) {
  const buf = safeBase64ToBuffer(
    typeof frameData === "string" ? frameData : frameData?.dataBase64 || "",
  );
  const histogram = new Array(8).fill(0);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const bucket = Math.min(7, Math.floor(buf[i] / 32));
    histogram[bucket]++;
    sum += buf[i];
  }
  const brightness = buf.length ? sum / buf.length / 255 : 0;
  return {
    hash: frameHash(frameData),
    histogram,
    brightness: Number(brightness.toFixed(4)),
    bytes: buf.length,
  };
}

registerFrameAnalyzer("default", defaultFrameAnalyzer);

/**
 * Analyze a single frame. Returns { hash, histogram, brightness, ... } using
 * the named analyzer (defaults to "default").
 */
export async function analyzeFrame(frameData, options = {}) {
  const name = options.analyzer || "default";
  const fn = frameAnalyzers.get(name);
  if (!fn) throw new Error(`analyzeFrame: unknown analyzer ${name}`);
  const result = await fn(frameData, options);
  return result && typeof result === "object" ? result : {};
}

// ---------------------------------------------------------------------------
// Temporal reasoning
// ---------------------------------------------------------------------------

/**
 * Detect scene changes by comparing adjacent frame hashes.
 * Returns [{ frameIndex, timestampMs, distance }] for frames where distance
 * to the previous frame exceeds `threshold` (default 12 bits).
 */
export function detectSceneChanges(frames, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 12;
  if (!Array.isArray(frames) || frames.length < 2) return [];
  const hashes = frames.map((f) => f.hash || frameHash(f));
  const changes = [];
  for (let i = 1; i < frames.length; i++) {
    const dist = hashDistance(hashes[i - 1], hashes[i]);
    if (dist >= threshold) {
      changes.push({
        frameIndex: frames[i].frameIndex ?? i,
        timestampMs: frames[i].timestampMs ?? 0,
        distance: dist,
      });
    }
  }
  return changes;
}

/**
 * Estimate motion intensity per frame by byte-level diff against neighbours.
 * Returns [{ frameIndex, motionScore }] where motionScore is [0, 1].
 */
export function detectMotion(frames) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  if (frames.length === 1) {
    return [{ frameIndex: frames[0].frameIndex ?? 0, motionScore: 0 }];
  }
  const buffers = frames.map((f) => safeBase64ToBuffer(f.dataBase64 || ""));
  const scores = [];
  for (let i = 0; i < frames.length; i++) {
    const cur = buffers[i];
    const prev = i > 0 ? buffers[i - 1] : cur;
    const next = i < buffers.length - 1 ? buffers[i + 1] : cur;
    let diff = 0;
    let len = 0;
    const n1 = Math.min(cur.length, prev.length);
    for (let k = 0; k < n1; k++) diff += Math.abs(cur[k] - prev[k]);
    len += n1;
    const n2 = Math.min(cur.length, next.length);
    for (let k = 0; k < n2; k++) diff += Math.abs(cur[k] - next[k]);
    len += n2;
    const motionScore = len ? Math.min(1, diff / (len * 255)) : 0;
    scores.push({
      frameIndex: frames[i].frameIndex ?? i,
      motionScore: Number(motionScore.toFixed(4)),
    });
  }
  return scores;
}

/**
 * Pick the most "informative" frames using greedy Hamming-distance selection:
 * start with the first frame and keep the frame that maximises the minimum
 * hash distance to already-selected frames.
 */
export function computeKeyframes(frames, maxKeyframes = 10) {
  if (!Array.isArray(frames) || frames.length === 0) return [];
  const n = frames.length;
  const k = Math.max(1, Math.min(maxKeyframes, n));
  const hashes = frames.map((f) => f.hash || frameHash(f));
  const picked = [0];
  while (picked.length < k) {
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < n; i++) {
      if (picked.includes(i)) continue;
      let minDist = Infinity;
      for (const p of picked) {
        const d = hashDistance(hashes[i], hashes[p]);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestScore) {
        bestScore = minDist;
        best = i;
      }
    }
    if (best < 0) break;
    picked.push(best);
  }
  picked.sort((a, b) => a - b);
  return picked.map((i) => ({
    frameIndex: frames[i].frameIndex ?? i,
    timestampMs: frames[i].timestampMs ?? 0,
    hash: hashes[i],
  }));
}

// ---------------------------------------------------------------------------
// analyzeVideo — full pipeline
// ---------------------------------------------------------------------------

export async function analyzeVideo(video, options = {}) {
  const metadata = video?.metadata instanceof VideoMetadata
    ? video.metadata
    : new VideoMetadata(video?.metadata || {});

  const frames = await sampleFrames(video, options);
  const frameAnalyses = [];
  for (const frame of frames) {
    const analysis = await analyzeFrame(frame.dataBase64, options);
    frameAnalyses.push({
      frameIndex: frame.frameIndex,
      timestampMs: frame.timestampMs,
      hash: analysis.hash,
      brightness: analysis.brightness,
      histogram: analysis.histogram,
    });
  }

  const scenes = detectSceneChanges(frameAnalyses, {
    threshold: options.sceneThreshold,
  });
  const motion = detectMotion(frames);
  const keyframes = computeKeyframes(
    frameAnalyses,
    Math.max(1, Number(options.maxKeyframes) || 5),
  );

  const summary = await generateVideoSummary({
    metadata,
    frameAnalyses,
    scenes,
    motion,
    keyframes,
  });

  return {
    metadata: metadata.toJSON(),
    frameAnalyses,
    scenes,
    motion,
    keyframes,
    summary,
  };
}

/**
 * Rule-based video summary from frame analyses and temporal features.
 */
export async function generateVideoSummary(analyses = {}) {
  const meta = analyses.metadata || {};
  const frameAnalyses = Array.isArray(analyses.frameAnalyses) ? analyses.frameAnalyses : [];
  const scenes = Array.isArray(analyses.scenes) ? analyses.scenes : [];
  const motion = Array.isArray(analyses.motion) ? analyses.motion : [];

  const parts = [];
  if (meta.duration) {
    parts.push(`Video lasts ${meta.duration.toFixed?.(1) || meta.duration}s`);
  } else {
    parts.push("Video");
  }
  if (meta.width && meta.height) {
    parts.push(`at ${meta.width}x${meta.height}`);
  }
  parts.push(`with ${frameAnalyses.length} sampled frame${frameAnalyses.length === 1 ? "" : "s"}`);

  const avgBrightness =
    frameAnalyses.length > 0
      ? frameAnalyses.reduce((a, f) => a + (Number(f.brightness) || 0), 0) / frameAnalyses.length
      : 0;
  const brightnessLabel =
    avgBrightness > 0.66 ? "bright" : avgBrightness > 0.33 ? "medium-lit" : "dark";
  parts.push(`overall ${brightnessLabel}`);

  parts.push(`${scenes.length} scene change${scenes.length === 1 ? "" : "s"} detected`);

  const avgMotion =
    motion.length > 0
      ? motion.reduce((a, m) => a + (Number(m.motionScore) || 0), 0) / motion.length
      : 0;
  const motionLabel = avgMotion > 0.5 ? "high" : avgMotion > 0.2 ? "moderate" : "low";
  parts.push(`${motionLabel} motion`);

  const text = parts.join(", ") + ".";
  return {
    text,
    stats: {
      sampledFrames: frameAnalyses.length,
      sceneChanges: scenes.length,
      avgBrightness: Number(avgBrightness.toFixed(4)),
      avgMotion: Number(avgMotion.toFixed(4)),
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function saveVideoAnalysis(videoId, analysis, extra = {}) {
  if (!videoId || typeof videoId !== "string") {
    throw new Error("saveVideoAnalysis: videoId is required");
  }
  if (!analysis || typeof analysis !== "object") {
    throw new Error("saveVideoAnalysis: analysis is required");
  }
  const entry = {
    videoId,
    workspaceId: extra.workspaceId || "default",
    userId: extra.userId || "anonymous",
    analysis,
    createdAt: new Date().toISOString(),
    id: extra.id || `va_${crypto.randomBytes(8).toString("hex")}`,
  };
  await withPathLock(analysesPath(), async () => {
    const items = await loadAnalyses();
    const filtered = items.filter((i) => i.videoId !== videoId);
    filtered.push(entry);
    await saveAnalyses(filtered);
  });
  return entry;
}

export async function getVideoAnalysis(videoId) {
  if (!videoId) return null;
  const items = await loadAnalyses();
  const found = items.find((i) => i.videoId === videoId || i.id === videoId);
  return found || null;
}

export async function listVideoAnalyses(workspaceId) {
  const items = await loadAnalyses();
  if (!workspaceId) return items.slice();
  return items.filter((i) => i.workspaceId === workspaceId);
}
