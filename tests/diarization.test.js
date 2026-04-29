/**
 * Phase 44.3: Speaker diarization tests.
 * Covers segment merging, transcript export formats, speaker enrollment,
 * and identification (mocked / deterministic voiceprint).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated STORAGE_PATH so the speaker store doesn't pollute real data.
const TMP = mkdtempSync(join(tmpdir(), "siskel-diar-"));
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_WHISPER_API_KEY = process.env.WHISPER_API_KEY;
process.env.STORAGE_PATH = TMP;
delete process.env.OPENAI_API_KEY;
delete process.env.WHISPER_API_KEY;

const lib = await import("../lib/diarization.js");
const {
  mergeAdjacentSpeakerSegments,
  computeSpeakerStats,
  formatTranscript,
  exportTranscript,
  enrollSpeaker,
  listSpeakers,
  deleteSpeaker,
  identifySpeaker,
  computeVoicePrint,
  hexSimilarity,
  assignSpeakersByEnergy,
  wordsToSpeakerSegments,
  getDiarizationCapabilities,
  diarizeAudio,
  transcribeWithDiarization,
  storeJob,
  getJob,
  _resetJobs,
} = lib;

test.after(() => {
  if (ORIGINAL_OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
  if (ORIGINAL_WHISPER_API_KEY === undefined) delete process.env.WHISPER_API_KEY;
  else process.env.WHISPER_API_KEY = ORIGINAL_WHISPER_API_KEY;
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ */
/* Segment merging                                                     */
/* ------------------------------------------------------------------ */

test("mergeAdjacentSpeakerSegments combines consecutive same-speaker segments", () => {
  const segments = [
    { speaker: "Speaker 1", start: 0, end: 1, text: "Hello" },
    { speaker: "Speaker 1", start: 1, end: 2, text: "world" },
    { speaker: "Speaker 2", start: 2, end: 3, text: "Hi" },
    { speaker: "Speaker 1", start: 3, end: 4, text: "Bye" },
  ];
  const merged = mergeAdjacentSpeakerSegments(segments);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].text, "Hello world");
  assert.equal(merged[0].start, 0);
  assert.equal(merged[0].end, 2);
  assert.equal(merged[1].speaker, "Speaker 2");
  assert.equal(merged[2].text, "Bye");
});

test("mergeAdjacentSpeakerSegments handles empty input", () => {
  assert.deepEqual(mergeAdjacentSpeakerSegments([]), []);
  assert.deepEqual(mergeAdjacentSpeakerSegments(null), []);
});

test("mergeAdjacentSpeakerSegments preserves single segment", () => {
  const seg = [{ speaker: "Speaker 1", start: 0, end: 5, text: "Solo" }];
  const merged = mergeAdjacentSpeakerSegments(seg);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "Solo");
});

test("computeSpeakerStats sums durations correctly", () => {
  const segments = [
    { speaker: "Speaker 1", start: 0, end: 2 },
    { speaker: "Speaker 2", start: 2, end: 5 },
    { speaker: "Speaker 1", start: 5, end: 7 },
  ];
  const stats = computeSpeakerStats(segments);
  assert.equal(stats.length, 2);
  // sorted by totalDuration desc
  assert.equal(stats[0].id, "Speaker 1");
  assert.equal(stats[0].totalDuration, 4);
  assert.equal(stats[0].segmentCount, 2);
  assert.equal(stats[1].id, "Speaker 2");
  assert.equal(stats[1].totalDuration, 3);
});

test("assignSpeakersByEnergy switches speaker on long silence", () => {
  const whisper = [
    { start: 0, end: 1, text: "hi", avg_logprob: -0.1 },
    { start: 1.1, end: 2, text: "there", avg_logprob: -0.1 },
    { start: 5, end: 6, text: "back", avg_logprob: -0.1 }, // 3s silence
  ];
  const segs = assignSpeakersByEnergy(whisper, 2);
  // First two segments are merged into Speaker 1; long silence flips to Speaker 2.
  assert.equal(segs.length, 2);
  assert.equal(segs[0].speaker, "Speaker 1");
  assert.equal(segs[1].speaker, "Speaker 2");
  assert.equal(segs[0].text, "hi there");
});

test("assignSpeakersByEnergy clamps expectedSpeakers to 1..8", () => {
  const whisper = [{ start: 0, end: 1, text: "x", avg_logprob: -0.1 }];
  const segs = assignSpeakersByEnergy(whisper, 0);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].speaker, "Speaker 1");
});

test("wordsToSpeakerSegments groups Deepgram words by speaker id", () => {
  const words = [
    { word: "hello", start: 0, end: 0.5, speaker: 0 },
    { word: "world", start: 0.5, end: 1, speaker: 0 },
    { word: "hi", start: 1, end: 1.5, speaker: 1 },
  ];
  const segs = wordsToSpeakerSegments(words);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].speaker, "Speaker 1");
  assert.equal(segs[0].text, "hello world");
  assert.equal(segs[1].speaker, "Speaker 2");
  assert.equal(segs[1].text, "hi");
});

/* ------------------------------------------------------------------ */
/* Transcript formatting + export                                       */
/* ------------------------------------------------------------------ */

const SAMPLE_SEGMENTS = [
  { speaker: "Speaker 1", start: 0, end: 2.5, text: "Hello" },
  { speaker: "Speaker 2", start: 2.5, end: 5, text: "Hi there" },
];

test("formatTranscript produces 'Speaker N: text' lines", () => {
  const out = formatTranscript(SAMPLE_SEGMENTS);
  assert.equal(out, "Speaker 1: Hello\nSpeaker 2: Hi there");
});

test("formatTranscript skips empty-text segments", () => {
  const out = formatTranscript([
    { speaker: "Speaker 1", text: "" },
    { speaker: "Speaker 1", text: "real" },
  ]);
  assert.equal(out, "Speaker 1: real");
});

test("exportTranscript txt format", () => {
  const out = exportTranscript(SAMPLE_SEGMENTS, "txt");
  assert.equal(out.contentType, "text/plain");
  assert.equal(out.filename, "transcript.txt");
  assert.ok(out.data.includes("Speaker 1: Hello"));
});

test("exportTranscript srt format includes timecodes and speaker labels", () => {
  const out = exportTranscript(SAMPLE_SEGMENTS, "srt");
  assert.equal(out.contentType, "application/x-subrip");
  assert.equal(out.filename, "transcript.srt");
  assert.ok(out.data.includes("00:00:00,000 --> 00:00:02,500"));
  assert.ok(out.data.includes("Speaker 1: Hello"));
  assert.ok(out.data.includes("00:00:02,500 --> 00:00:05,000"));
  // SRT entries are numbered starting at 1
  assert.ok(out.data.startsWith("1\n"));
});

test("exportTranscript vtt format starts with WEBVTT and uses dot timecodes", () => {
  const out = exportTranscript(SAMPLE_SEGMENTS, "vtt");
  assert.equal(out.contentType, "text/vtt");
  assert.ok(out.data.startsWith("WEBVTT"));
  assert.ok(out.data.includes("00:00:00.000 --> 00:00:02.500"));
  assert.ok(out.data.includes("<v Speaker 1>Hello"));
});

test("exportTranscript json format returns parsable JSON", () => {
  const out = exportTranscript(SAMPLE_SEGMENTS, "json");
  assert.equal(out.contentType, "application/json");
  const parsed = JSON.parse(out.data);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].speaker, "Speaker 1");
});

test("exportTranscript rejects unknown format", () => {
  assert.throws(() => exportTranscript(SAMPLE_SEGMENTS, "xml"), /unsupported export format/);
});

test("exportTranscript handles missing segments gracefully", () => {
  const out = exportTranscript(null, "txt");
  assert.equal(out.data, "");
});

/* ------------------------------------------------------------------ */
/* Voiceprint + speaker enrollment                                      */
/* ------------------------------------------------------------------ */

test("computeVoicePrint returns deterministic hex hash", () => {
  const sample = Buffer.from("voice-sample-data-of-some-length-here");
  const a = computeVoicePrint(sample);
  const b = computeVoicePrint(sample);
  assert.equal(a, b);
  assert.equal(typeof a, "string");
  assert.ok(a.length >= 32);
});

test("computeVoicePrint differs for different audio", () => {
  const a = computeVoicePrint(Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  const b = computeVoicePrint(Buffer.from("bbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
  assert.notEqual(a, b);
});

test("computeVoicePrint rejects empty buffer", () => {
  assert.throws(() => computeVoicePrint(null), /audio sample required/);
  assert.throws(() => computeVoicePrint(Buffer.alloc(0)), /audio sample required/);
});

test("hexSimilarity returns 1.0 for identical strings, 0 for empty", () => {
  assert.equal(hexSimilarity("abc123", "abc123"), 1);
  assert.equal(hexSimilarity("", ""), 0);
  assert.ok(hexSimilarity("abcdef", "abcfff") < 1);
  assert.ok(hexSimilarity("abcdef", "abcfff") > 0);
});

test("enrollSpeaker stores a record and listSpeakers returns it", async () => {
  // Reset store to a known state for this test by deleting any prior entries.
  const existing = await listSpeakers();
  for (const s of existing) await deleteSpeaker(s.speakerId);

  const sample = Buffer.from("alice-voice-sample-data-padding-padding-padding");
  const record = await enrollSpeaker("user-alice", sample, "Alice");
  assert.ok(record.speakerId.startsWith("spk_"));
  assert.equal(record.userId, "user-alice");
  assert.equal(record.displayName, "Alice");
  assert.ok(record.printHash);
  assert.ok(record.enrolledAt);

  const all = await listSpeakers();
  assert.ok(all.some((s) => s.speakerId === record.speakerId));

  const filtered = await listSpeakers("user-alice");
  assert.equal(filtered.length, 1);
});

test("enrollSpeaker rejects missing displayName", async () => {
  await assert.rejects(
    () => enrollSpeaker("u1", Buffer.from("sample"), ""),
    (err) => err.code === "INVALID_INPUT"
  );
});

test("enrollSpeaker rejects empty audio", async () => {
  await assert.rejects(
    () => enrollSpeaker("u1", Buffer.alloc(0), "Name"),
    (err) => err.code === "INVALID_INPUT"
  );
});

test("deleteSpeaker removes a record", async () => {
  const sample = Buffer.from("bob-voice-sample-data-padding-padding-padding");
  const rec = await enrollSpeaker("user-bob", sample, "Bob");
  const ok = await deleteSpeaker(rec.speakerId);
  assert.equal(ok, true);
  const all = await listSpeakers();
  assert.ok(!all.some((s) => s.speakerId === rec.speakerId));
  // Deleting again returns false
  const again = await deleteSpeaker(rec.speakerId);
  assert.equal(again, false);
});

/* ------------------------------------------------------------------ */
/* Identification (mocked: matches stored voiceprint deterministically) */
/* ------------------------------------------------------------------ */

test("identifySpeaker matches enrolled speaker by exact voiceprint", async () => {
  // Clear store
  for (const s of await listSpeakers()) await deleteSpeaker(s.speakerId);

  const sample = Buffer.from("carol-voice-sample-with-distinctive-content-here-1234");
  const enrolled = await enrollSpeaker("user-carol", sample, "Carol");

  // Identify with the same audio: similarity should be 1.0.
  const match = await identifySpeaker(sample);
  assert.equal(match.speakerId, enrolled.speakerId);
  assert.equal(match.displayName, "Carol");
  assert.equal(match.confidence, 1);
});

test("identifySpeaker returns no match when store is empty", async () => {
  for (const s of await listSpeakers()) await deleteSpeaker(s.speakerId);
  const match = await identifySpeaker(Buffer.from("unknown-speaker-audio"));
  assert.equal(match.speakerId, null);
  assert.equal(match.confidence, 0);
});

test("identifySpeaker against explicit candidate list", async () => {
  const sample = Buffer.from("known-sample-data-1234567890abcdef");
  const printHash = computeVoicePrint(sample);
  const match = await identifySpeaker(sample, [
    { speakerId: "spk_test", printHash, displayName: "Tester" },
  ]);
  assert.equal(match.speakerId, "spk_test");
  assert.equal(match.confidence, 1);
});

test("identifySpeaker returns lower confidence for different audio", async () => {
  const enrolled = Buffer.from("speakerA-voice-sample-aaaaaaaaaaaaaaaaaaaaa");
  const printHash = computeVoicePrint(enrolled);
  const other = Buffer.from("speakerB-voice-sample-bbbbbbbbbbbbbbbbbbbbb");
  const match = await identifySpeaker(other, [
    { speakerId: "spk_a", printHash, displayName: "A" },
  ]);
  assert.ok(match.confidence < 1);
});

/* ------------------------------------------------------------------ */
/* Provider routing + capabilities                                      */
/* ------------------------------------------------------------------ */

test("getDiarizationCapabilities returns provider availability flags", () => {
  const caps = getDiarizationCapabilities();
  assert.equal(typeof caps.provider, "string");
  assert.equal(typeof caps.providers, "object");
  assert.equal(typeof caps.providers.openai, "boolean");
  assert.equal(typeof caps.providers.assemblyai, "boolean");
  assert.equal(typeof caps.providers.deepgram, "boolean");
  assert.equal(typeof caps.providers.pyannote, "boolean");
});

test("diarizeAudio rejects empty buffer", async () => {
  await assert.rejects(
    () => diarizeAudio(Buffer.alloc(0)),
    (err) => err.code === "INVALID_INPUT"
  );
});

test("diarizeAudio rejects unknown provider", async () => {
  await assert.rejects(
    () => diarizeAudio(Buffer.from("audio"), { provider: "imaginary" }),
    (err) =>
      err.code === "INVALID_INPUT" || err.code === "DIARIZATION_NOT_CONFIGURED"
  );
});

test("diarizeAudio with openai provider rejects when no API keys are set", async () => {
  const orig = { o: process.env.OPENAI_API_KEY, w: process.env.WHISPER_API_KEY };
  process.env.OPENAI_API_KEY = "";
  process.env.WHISPER_API_KEY = "";
  try {
    // Re-import to pick up env at module load time? The lib reads env at import,
    // so for this test we just rely on the existing module's behavior. If the
    // host environment already has keys set, the call would attempt a real
    // network request — guard with a feature check.
    const caps = getDiarizationCapabilities();
    if (!caps.providers.openai) {
      await assert.rejects(
        () => diarizeAudio(Buffer.from("audio-data"), { provider: "openai" }),
        (err) => err.code === "DIARIZATION_NOT_CONFIGURED"
      );
    }
  } finally {
    process.env.OPENAI_API_KEY = orig.o || "";
    process.env.WHISPER_API_KEY = orig.w || "";
  }
});

/* ------------------------------------------------------------------ */
/* Job store                                                            */
/* ------------------------------------------------------------------ */

test("storeJob and getJob round-trip", () => {
  _resetJobs();
  const result = { segments: SAMPLE_SEGMENTS, speakers: [], transcript: "x" };
  storeJob("job-1", result);
  const got = getJob("job-1");
  assert.equal(got, result);
});

test("getJob returns null for unknown id", () => {
  _resetJobs();
  assert.equal(getJob("missing"), null);
});

test("transcribeWithDiarization composes diarize result with transcript string", async () => {
  // We can't make real network calls, so monkey-patch fetch to return a fake
  // Whisper verbose_json response.
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      language: "en",
      segments: [
        { start: 0, end: 1, text: "hello", avg_logprob: -0.1 },
        { start: 1.5, end: 2.5, text: "world", avg_logprob: -0.1 },
      ],
    }),
  });
  // Make sure openai key path is taken
  const origKey = process.env.OPENAI_API_KEY;
  if (!process.env.OPENAI_API_KEY && !process.env.WHISPER_API_KEY) {
    process.env.OPENAI_API_KEY = "test-key";
  }
  try {
    const out = await transcribeWithDiarization(Buffer.from("fake-audio"), {
      provider: "openai",
      expectedSpeakers: 2,
    });
    assert.ok(Array.isArray(out.segments));
    assert.equal(typeof out.transcript, "string");
    assert.ok(out.transcript.includes("Speaker"));
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = origKey;
  }
});
