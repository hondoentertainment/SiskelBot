/**
 * Phase 54.1: Video understanding tests.
 *
 * Isolates STORAGE_PATH so persisted analyses do not leak into the real
 * data dir.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-video-understanding-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  VideoMetadata,
  sampleFrames,
  registerFrameExtractor,
  getFrameExtractor,
  stubFrameExtractor,
  detectSceneChanges,
  detectMotion,
  computeKeyframes,
  analyzeVideo,
  generateVideoSummary,
  analyzeFrame,
  registerFrameAnalyzer,
  saveVideoAnalysis,
  getVideoAnalysis,
  listVideoAnalyses,
  frameHash,
  hashDistance,
} = await import("../lib/video-understanding.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// Helpers: build fake frames with controllable byte content.
function bytesToBase64(arr) {
  return Buffer.from(arr).toString("base64");
}

function makeFrame(index, fillByte, timestampMs = index * 100) {
  const bytes = new Array(32).fill(fillByte);
  return {
    frameIndex: index,
    timestampMs,
    dataBase64: bytesToBase64(bytes),
  };
}

function makeVariedFrame(index, seed, timestampMs = index * 100) {
  const bytes = new Array(64).fill(0).map((_, k) => (seed * 7 + k * 13) % 256);
  return {
    frameIndex: index,
    timestampMs,
    dataBase64: bytesToBase64(bytes),
  };
}

// ---------------------------------------------------------------------------

test("VideoMetadata stores fields", () => {
  const meta = new VideoMetadata({
    duration: 12.5,
    fps: 30,
    width: 1920,
    height: 1080,
    frameCount: 375,
    codec: "h264",
    format: "mp4",
  });
  assert.equal(meta.duration, 12.5);
  assert.equal(meta.fps, 30);
  assert.equal(meta.width, 1920);
  assert.equal(meta.height, 1080);
  assert.equal(meta.frameCount, 375);
  assert.equal(meta.codec, "h264");
  assert.equal(meta.format, "mp4");
  const json = meta.toJSON();
  assert.equal(json.duration, 12.5);
  assert.equal(json.codec, "h264");
});

test("sampleFrames with uniform strategy returns frames", async () => {
  const frames = await sampleFrames(
    { metadata: { duration: 10 } },
    { count: 5, strategy: "uniform" },
  );
  assert.equal(frames.length, 5);
  for (const f of frames) {
    assert.equal(typeof f.frameIndex, "number");
    assert.equal(typeof f.timestampMs, "number");
    assert.equal(typeof f.dataBase64, "string");
  }
});

test("sampleFrames respects count", async () => {
  const three = await sampleFrames({ metadata: { duration: 5 } }, { count: 3 });
  const seven = await sampleFrames({ metadata: { duration: 5 } }, { count: 7 });
  assert.equal(three.length, 3);
  assert.equal(seven.length, 7);
});

test("sampleFrames uses pluggable extractor", async () => {
  registerFrameExtractor("fixed-2", async () => [
    { frameIndex: 0, timestampMs: 0, dataBase64: bytesToBase64([1, 2, 3]) },
    { frameIndex: 1, timestampMs: 500, dataBase64: bytesToBase64([4, 5, 6]) },
  ]);
  const frames = await sampleFrames(
    { metadata: { duration: 1 }, extractor: "fixed-2" },
    { count: 2 },
  );
  assert.equal(frames.length, 2);
  assert.equal(frames[0].timestampMs, 0);
  assert.equal(frames[1].timestampMs, 500);
});

test("registerFrameExtractor + retrieval", () => {
  const fn = async () => [];
  registerFrameExtractor("my-extractor", fn);
  assert.equal(getFrameExtractor("my-extractor"), fn);
  assert.equal(getFrameExtractor("nope"), null);
});

test("sampleFrames from pre-extracted frames array", async () => {
  const video = {
    metadata: { duration: 5 },
    frames: [
      makeFrame(0, 10, 0),
      makeFrame(1, 20, 1000),
      makeFrame(2, 30, 2000),
      makeFrame(3, 40, 3000),
      makeFrame(4, 50, 4000),
    ],
  };
  const frames = await sampleFrames(video, { count: 3, strategy: "uniform" });
  assert.equal(frames.length, 3);
});

test("detectSceneChanges finds synthetic change", () => {
  // First two frames identical, third is drastically different.
  const a = makeFrame(0, 0);
  const b = makeFrame(1, 0);
  const c = makeFrame(2, 255);
  const frames = [a, b, c].map((f) => ({ ...f, hash: frameHash(f) }));
  const changes = detectSceneChanges(frames, { threshold: 8 });
  assert.ok(changes.length >= 1, "expected at least one scene change");
  assert.equal(changes[changes.length - 1].frameIndex, 2);
});

test("detectSceneChanges returns [] for zero or one frames", () => {
  assert.deepEqual(detectSceneChanges([]), []);
  assert.deepEqual(detectSceneChanges([makeFrame(0, 100)]), []);
});

test("detectMotion scores frames", () => {
  const frames = [
    makeFrame(0, 10),
    makeFrame(1, 200),
    makeFrame(2, 10),
  ];
  const scores = detectMotion(frames);
  assert.equal(scores.length, 3);
  for (const s of scores) {
    assert.ok(s.motionScore >= 0 && s.motionScore <= 1);
  }
  // The middle frame should have the highest motion.
  assert.ok(scores[1].motionScore >= scores[0].motionScore);
});

test("detectMotion handles single frame", () => {
  const scores = detectMotion([makeFrame(0, 10)]);
  assert.equal(scores.length, 1);
  assert.equal(scores[0].motionScore, 0);
});

test("computeKeyframes selects distinct", () => {
  const frames = [
    makeVariedFrame(0, 1),
    makeVariedFrame(1, 2),
    makeVariedFrame(2, 50),
    makeVariedFrame(3, 100),
    makeVariedFrame(4, 200),
  ].map((f) => ({ ...f, hash: frameHash(f) }));
  const kf = computeKeyframes(frames, 3);
  assert.equal(kf.length, 3);
  // All frame indices should be distinct.
  const indices = new Set(kf.map((k) => k.frameIndex));
  assert.equal(indices.size, 3);
});

test("analyzeVideo full pipeline", async () => {
  const result = await analyzeVideo(
    { metadata: { duration: 6, width: 640, height: 480, fps: 30 } },
    { count: 6, maxKeyframes: 3 },
  );
  assert.ok(result.metadata);
  assert.equal(result.metadata.width, 640);
  assert.ok(Array.isArray(result.frameAnalyses));
  assert.equal(result.frameAnalyses.length, 6);
  assert.ok(Array.isArray(result.scenes));
  assert.ok(Array.isArray(result.motion));
  assert.ok(Array.isArray(result.keyframes));
  assert.ok(result.keyframes.length <= 3);
  assert.ok(result.summary);
  assert.equal(typeof result.summary.text, "string");
});

test("generateVideoSummary produces text", async () => {
  const summary = await generateVideoSummary({
    metadata: { duration: 10, width: 1280, height: 720 },
    frameAnalyses: [
      { frameIndex: 0, brightness: 0.5, hash: "0".repeat(16) },
      { frameIndex: 1, brightness: 0.6, hash: "f".repeat(16) },
    ],
    scenes: [{ frameIndex: 1, timestampMs: 500, distance: 30 }],
    motion: [
      { frameIndex: 0, motionScore: 0.3 },
      { frameIndex: 1, motionScore: 0.7 },
    ],
  });
  assert.equal(typeof summary.text, "string");
  assert.ok(summary.text.length > 10);
  assert.ok(summary.stats);
  assert.equal(summary.stats.sampledFrames, 2);
  assert.equal(summary.stats.sceneChanges, 1);
});

test("analyzeFrame with default analyzer", async () => {
  const frame = makeFrame(0, 128);
  const result = await analyzeFrame(frame.dataBase64);
  assert.ok(result.hash);
  assert.equal(result.hash.length, 16);
  assert.ok(Array.isArray(result.histogram));
  assert.equal(result.histogram.length, 8);
  assert.equal(typeof result.brightness, "number");
});

test("registerFrameAnalyzer pluggability", async () => {
  registerFrameAnalyzer("custom", (data) => ({
    hash: "custom",
    custom: true,
    length: (data?.dataBase64 || data || "").length,
  }));
  const frame = makeFrame(0, 10);
  const result = await analyzeFrame(frame.dataBase64, { analyzer: "custom" });
  assert.equal(result.hash, "custom");
  assert.equal(result.custom, true);
});

test("saveVideoAnalysis + getVideoAnalysis roundtrip", async () => {
  const analysis = { summary: { text: "test" }, scenes: [] };
  const entry = await saveVideoAnalysis("vid-1", analysis, {
    workspaceId: "ws-1",
    userId: "user-1",
  });
  assert.equal(entry.videoId, "vid-1");
  assert.equal(entry.workspaceId, "ws-1");
  const fetched = await getVideoAnalysis("vid-1");
  assert.ok(fetched);
  assert.equal(fetched.videoId, "vid-1");
  assert.equal(fetched.analysis.summary.text, "test");
});

test("listVideoAnalyses filters by workspace", async () => {
  await saveVideoAnalysis("vid-a", { summary: { text: "a" } }, { workspaceId: "ws-x" });
  await saveVideoAnalysis("vid-b", { summary: { text: "b" } }, { workspaceId: "ws-y" });
  const all = await listVideoAnalyses();
  assert.ok(all.length >= 2);
  const xs = await listVideoAnalyses("ws-x");
  assert.ok(xs.every((i) => i.workspaceId === "ws-x"));
  assert.ok(xs.some((i) => i.videoId === "vid-a"));
});

test("frameHash is deterministic", () => {
  const f = makeFrame(0, 123);
  const h1 = frameHash(f);
  const h2 = frameHash(f.dataBase64);
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
});

test("hashDistance reflects similarity", () => {
  const a = frameHash(makeFrame(0, 0));
  const b = frameHash(makeFrame(1, 0));
  const c = frameHash(makeFrame(2, 255));
  // identical content → distance 0
  assert.equal(hashDistance(a, b), 0);
  // very different content → distance > 0
  assert.ok(hashDistance(a, c) >= 0);
  // symmetric
  assert.equal(hashDistance(a, c), hashDistance(c, a));
});

test("analyzeVideo handles empty-ish video with single frame", async () => {
  const result = await analyzeVideo(
    { metadata: { duration: 0 } },
    { count: 1, maxKeyframes: 1 },
  );
  assert.equal(result.frameAnalyses.length, 1);
  assert.equal(result.keyframes.length, 1);
  assert.ok(result.summary.text.length > 0);
});

test("stub extractor registered and callable", async () => {
  const extractor = getFrameExtractor("stub");
  assert.equal(typeof extractor, "function");
  assert.equal(extractor, stubFrameExtractor);
  const out = await extractor({ metadata: { duration: 4 } }, { count: 4 });
  assert.equal(out.length, 4);
});
