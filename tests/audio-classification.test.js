/**
 * Phase 54.3: Audio beyond STT — classification tests.
 * Covers pluggable classifier registration, mock determinism, per-domain
 * classify helpers, segment-level and stream event detection, feature
 * extraction, fingerprinting, and persistence roundtrip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated STORAGE_PATH for persistence tests.
const TMP = mkdtempSync(join(tmpdir(), "siskel-audio-cls-"));
process.env.STORAGE_PATH = TMP;

const {
  CATEGORIES,
  AudioAnalysis,
  registerClassifier,
  getClassifier,
  mockClassifier,
  classifyMusic,
  classifyEvents,
  classifyEmotion,
  classifyAcoustic,
  analyzeAudio,
  analyzeSegments,
  extractFeatures,
  computeAudioFingerprint,
  saveAnalysis,
  getAnalysis,
  listAnalyses,
  detectEventsInStream,
  _clearClassifiers,
  _resetAnalyses,
} = await import("../lib/audio-classification.js");

test.after(() => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sampleBuf(seed = 0xab, size = 2048) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed + i * 7) & 0xff;
  }
  return buf;
}

test("CATEGORIES has all four domains", () => {
  assert.ok(CATEGORIES.music && CATEGORIES.music.length >= 5);
  assert.ok(CATEGORIES.events && CATEGORIES.events.includes("speech"));
  assert.ok(CATEGORIES.emotion && CATEGORIES.emotion.includes("happy"));
  assert.ok(CATEGORIES.acoustic && CATEGORIES.acoustic.includes("indoor"));
  assert.deepEqual(
    Object.keys(CATEGORIES).sort(),
    ["acoustic", "emotion", "events", "music"],
  );
});

test("registerClassifier + getClassifier installs a custom backend", async () => {
  _clearClassifiers();
  const custom = (audio, domain) => ({
    domain,
    label: "custom-label",
    confidence: 0.99,
    scores: { "custom-label": 0.99 },
  });
  registerClassifier("music", custom);
  assert.equal(getClassifier("music"), custom);

  const result = await classifyMusic(sampleBuf());
  assert.equal(result.label, "custom-label");
  assert.equal(result.confidence, 0.99);

  _clearClassifiers();
  // After clearing, falls back to mockClassifier.
  assert.equal(getClassifier("music"), mockClassifier);
});

test("registerClassifier rejects invalid domain", () => {
  assert.throws(() => registerClassifier("nonsense", () => ({})), /invalid domain/);
  assert.throws(() => registerClassifier("music", null), /must be a function/);
});

test("getClassifier rejects invalid domain", () => {
  assert.throws(() => getClassifier("bogus"), /invalid domain/);
});

test("mockClassifier returns deterministic result for same input", () => {
  const buf = sampleBuf(1);
  const a = mockClassifier(buf, "music");
  const b = mockClassifier(buf, "music");
  assert.equal(a.label, b.label);
  assert.equal(a.confidence, b.confidence);
  assert.deepEqual(a.scores, b.scores);
  assert.ok(CATEGORIES.music.includes(a.label));
});

test("mockClassifier differs across domains for the same buffer", () => {
  const buf = sampleBuf(42);
  const m = mockClassifier(buf, "music");
  const e = mockClassifier(buf, "events");
  assert.equal(m.domain, "music");
  assert.equal(e.domain, "events");
  assert.ok(CATEGORIES.music.includes(m.label));
  assert.ok(CATEGORIES.events.includes(e.label));
});

test("mockClassifier rejects invalid domain", () => {
  assert.throws(() => mockClassifier(sampleBuf(), "unknown"), /invalid domain/);
});

test("classifyMusic returns music-domain label via mock", async () => {
  _clearClassifiers();
  const result = await classifyMusic(sampleBuf(7));
  assert.equal(result.domain, "music");
  assert.ok(CATEGORIES.music.includes(result.label));
  assert.ok(typeof result.confidence === "number");
  assert.ok(result.scores && typeof result.scores === "object");
});

test("classifyEvents returns events-domain label via mock", async () => {
  _clearClassifiers();
  const result = await classifyEvents(sampleBuf(8));
  assert.equal(result.domain, "events");
  assert.ok(CATEGORIES.events.includes(result.label));
});

test("classifyEmotion returns emotion-domain label via mock", async () => {
  _clearClassifiers();
  const result = await classifyEmotion(sampleBuf(9));
  assert.equal(result.domain, "emotion");
  assert.ok(CATEGORIES.emotion.includes(result.label));
});

test("classifyAcoustic returns acoustic-domain label via mock", async () => {
  _clearClassifiers();
  const result = await classifyAcoustic(sampleBuf(10));
  assert.equal(result.domain, "acoustic");
  assert.ok(CATEGORIES.acoustic.includes(result.label));
});

test("analyzeAudio runs all domains by default", async () => {
  _clearClassifiers();
  const result = await analyzeAudio(sampleBuf(11), { sampleRate: 16000 });
  assert.ok(result.music);
  assert.ok(result.events);
  assert.ok(result.emotion);
  assert.ok(result.acoustic);
  assert.equal(result.sampleRate, 16000);
  assert.ok(result.duration > 0);
  assert.ok(typeof result.fingerprint === "string" && result.fingerprint.length === 64);
});

test("analyzeAudio honours explicit domains list", async () => {
  _clearClassifiers();
  const result = await analyzeAudio(sampleBuf(12), { domains: ["music", "emotion"] });
  assert.ok(result.music);
  assert.ok(result.emotion);
  assert.equal(result.events, null);
  assert.equal(result.acoustic, null);
});

test("analyzeAudio rejects invalid domain in options", async () => {
  await assert.rejects(
    () => analyzeAudio(sampleBuf(13), { domains: ["music", "bogus"] }),
    /invalid domain/,
  );
});

test("analyzeSegments splits buffer into chunks and analyzes each", async () => {
  _clearClassifiers();
  // 16 kHz * 2 bytes/sample * 3 seconds = 96000 bytes.
  const buf = sampleBuf(0x3c, 96_000);
  const segments = await analyzeSegments(buf, 1000, { sampleRate: 16000 });
  assert.equal(segments.length, 3);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[0].durationMs, 1000);
  assert.equal(segments[1].startMs, 1000);
  assert.equal(segments[2].endMs, 3000);
  for (const seg of segments) {
    assert.ok(seg.analysis.music && seg.analysis.events);
  }
});

test("analyzeSegments returns [] for empty audio", async () => {
  const segments = await analyzeSegments(Buffer.alloc(0), 500);
  assert.deepEqual(segments, []);
});

test("extractFeatures returns expected shape", () => {
  const f = extractFeatures(sampleBuf(5));
  assert.ok(Array.isArray(f.mfcc));
  assert.equal(f.mfcc.length, 13);
  assert.ok(typeof f.zcr === "number");
  assert.ok(typeof f.rms === "number");
  assert.ok(typeof f.spectralCentroid === "number");
  assert.equal(f.length, 2048);
});

test("extractFeatures handles empty input", () => {
  const f = extractFeatures(Buffer.alloc(0));
  assert.deepEqual(f.mfcc, []);
  assert.equal(f.zcr, 0);
  assert.equal(f.rms, 0);
  assert.equal(f.spectralCentroid, 0);
  assert.equal(f.length, 0);
});

test("computeAudioFingerprint is deterministic and input-sensitive", () => {
  const a = computeAudioFingerprint(sampleBuf(1));
  const b = computeAudioFingerprint(sampleBuf(1));
  const c = computeAudioFingerprint(sampleBuf(2));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 64);
});

test("saveAnalysis + getAnalysis roundtrip", async () => {
  await _resetAnalyses();
  _clearClassifiers();
  const analysis = await analyzeAudio(sampleBuf(21), { audioId: "audio-A" });
  const saved = await saveAnalysis("audio-A", analysis);
  assert.equal(saved.audioId, "audio-A");
  assert.ok(saved.savedAt);

  const fetched = await getAnalysis("audio-A");
  assert.ok(fetched);
  assert.equal(fetched.audioId, "audio-A");
  assert.equal(fetched.music.label, analysis.music.label);
});

test("saveAnalysis validates inputs", async () => {
  await assert.rejects(() => saveAnalysis("", { music: null }), /audioId is required/);
  await assert.rejects(() => saveAnalysis("x", null), /analysis is required/);
});

test("listAnalyses filters by audioId and label", async () => {
  await _resetAnalyses();
  _clearClassifiers();
  const a1 = await analyzeAudio(sampleBuf(31), { audioId: "track-1" });
  const a2 = await analyzeAudio(sampleBuf(32), { audioId: "track-2" });
  await saveAnalysis("track-1", a1);
  await saveAnalysis("track-2", a2);

  const all = await listAnalyses();
  assert.ok(all.length >= 2);

  const onlyOne = await listAnalyses({ audioId: "track-1" });
  assert.equal(onlyOne.length, 1);
  assert.equal(onlyOne[0].audioId, "track-1");

  const byLabel = await listAnalyses({ musicLabel: a1.music.label });
  assert.ok(byLabel.some((e) => e.audioId === "track-1"));
});

test("detectEventsInStream produces timestamped labels", async () => {
  _clearClassifiers();
  const chunks = [sampleBuf(1, 32_000), sampleBuf(2, 32_000), sampleBuf(3, 32_000)];
  const events = await detectEventsInStream(chunks, { sampleRate: 16000 });
  assert.equal(events.length, 3);
  assert.equal(events[0].timestampMs, 0);
  assert.ok(events[1].timestampMs > events[0].timestampMs);
  assert.ok(CATEGORIES.events.includes(events[0].event));
  assert.ok(events[0].durationMs > 0);
});

test("detectEventsInStream handles empty array", async () => {
  const events = await detectEventsInStream([]);
  assert.deepEqual(events, []);
});

test("AudioAnalysis serializes via toJSON with stable shape", () => {
  const a = new AudioAnalysis({
    audioId: "x",
    duration: 1000,
    sampleRate: 16000,
    music: { label: "rock", confidence: 0.5, scores: {} },
  });
  const json = a.toJSON();
  assert.equal(json.audioId, "x");
  assert.equal(json.duration, 1000);
  assert.equal(json.sampleRate, 16000);
  assert.equal(json.music.label, "rock");
  assert.ok(json.id && json.id.startsWith("audio_"));
  assert.ok(json.createdAt);
  // Must not include unknown fields.
  const keys = Object.keys(json).sort();
  assert.deepEqual(keys, [
    "acoustic",
    "audioId",
    "createdAt",
    "duration",
    "emotion",
    "events",
    "features",
    "fingerprint",
    "id",
    "meta",
    "music",
    "sampleRate",
    "segments",
  ]);
});

test("analyzeAudio handles empty audio gracefully", async () => {
  _clearClassifiers();
  const result = await analyzeAudio(Buffer.alloc(0));
  assert.equal(result.duration, 0);
  assert.ok(result.music && result.events && result.emotion && result.acoustic);
  assert.equal(result.fingerprint.length, 64);
});
