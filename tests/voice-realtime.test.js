/**
 * Phase 44.1: Tests for real-time voice conversation.
 *
 * Covers:
 *   - Voice session lifecycle (start, audio, end)
 *   - VAD (silence detection / end-of-utterance)
 *   - Streaming STT and TTS generators
 *   - Stats tracking
 *   - Mock STT/TTS providers
 *   - HTTP routes (create / get stats / delete)
 */

import test from "node:test";
import assert from "node:assert/strict";

const VOICE_MODULE = "../lib/voice-realtime.js";

function makePcmChunk(samples, amplitude) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(amplitude, i * 2);
  }
  return buf;
}

test("computeRms returns 0 for empty buffer", async () => {
  const { computeRms } = await import(VOICE_MODULE);
  assert.equal(computeRms(Buffer.alloc(0)), 0);
  assert.equal(computeRms(null), 0);
});

test("computeRms returns correct RMS for constant amplitude", async () => {
  const { computeRms } = await import(VOICE_MODULE);
  const buf = makePcmChunk(100, 1000);
  const rms = computeRms(buf);
  assert.ok(Math.abs(rms - 1000) < 1, `expected ~1000 got ${rms}`);
});

test("detectEndOfSpeech reports speech for loud audio", async () => {
  const { detectEndOfSpeech } = await import(VOICE_MODULE);
  // 16k samples (1s) of audible signal
  const loud = makePcmChunk(16000, 5000);
  const result = await detectEndOfSpeech(loud, { silenceMs: 0 });
  assert.equal(result.speechDetected, true);
  assert.equal(result.endOfUtterance, false);
  assert.equal(result.silenceMs, 0);
});

test("detectEndOfSpeech accumulates silence and triggers end-of-utterance", async () => {
  const { detectEndOfSpeech } = await import(VOICE_MODULE);
  // 16000 samples @ 16kHz = 1000ms; default VAD_SILENCE_THRESHOLD_MS=700
  const silent = makePcmChunk(16000, 0);
  const result = await detectEndOfSpeech(silent, { silenceMs: 0 });
  assert.equal(result.speechDetected, false);
  assert.ok(result.silenceMs >= 1000, `silence should accumulate, got ${result.silenceMs}`);
  assert.equal(result.endOfUtterance, true);
});

test("detectEndOfSpeech does not trigger end-of-utterance below threshold", async () => {
  const { detectEndOfSpeech } = await import(VOICE_MODULE);
  // 1600 samples @ 16kHz = ~100ms of silence
  const tinySilence = makePcmChunk(1600, 0);
  const result = await detectEndOfSpeech(tinySilence, { silenceMs: 0 });
  assert.equal(result.speechDetected, false);
  assert.equal(result.endOfUtterance, false);
});

test("createVoiceSession startSession returns id and timestamp", async () => {
  const { createVoiceSession, _resetForTests } = await import(VOICE_MODULE);
  _resetForTests();
  const session = createVoiceSession({ sttProvider: "openai", ttsProvider: "openai" });
  const info = await session.startSession(() => {}, () => {}, () => {});
  assert.ok(info.id);
  assert.ok(info.startedAt > 0);
  assert.equal(session.active, true);
  await session.endSession();
});

test("createVoiceSession sendAudioChunk requires startSession", async () => {
  const { createVoiceSession, _resetForTests } = await import(VOICE_MODULE);
  _resetForTests();
  const session = createVoiceSession({});
  await assert.rejects(async () => session.sendAudioChunk(Buffer.alloc(10)), /not started/i);
});

test("createVoiceSession runs STT/LLM/TTS pipeline on end-of-utterance", async () => {
  const { createVoiceSession, _resetForTests } = await import(VOICE_MODULE);
  _resetForTests();
  const transcripts = [];
  const responses = [];
  const audioOut = [];

  const transcribeFn = async () => ({ text: "hello world", confidence: 0.95 });
  const completeFn = async (text) => `you said: ${text}`;
  const synthesizeFn = async (text) => ({ audio: Buffer.from(`AUDIO:${text}`), contentType: "audio/mpeg" });

  const session = createVoiceSession({ transcribeFn, completeFn, synthesizeFn });
  await session.startSession(
    (t) => transcripts.push(t),
    (r) => responses.push(r),
    (a) => audioOut.push(a)
  );

  // Send a loud chunk first (speech), then enough silence to trigger end-of-utterance.
  await session.sendAudioChunk(makePcmChunk(8000, 5000));
  await session.sendAudioChunk(makePcmChunk(16000, 0));

  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].text, "hello world");
  assert.equal(transcripts[0].isFinal, true);

  assert.equal(responses.length, 1);
  assert.equal(responses[0].text, "you said: hello world");

  assert.equal(audioOut.length, 1);
  assert.ok(audioOut[0].audio.toString().startsWith("AUDIO:"));

  await session.endSession();
});

test("session stats track audio seconds and transcript chars", async () => {
  const { createVoiceSession, _resetForTests } = await import(VOICE_MODULE);
  _resetForTests();

  const transcribeFn = async () => ({ text: "hi" });
  const completeFn = async () => "yo";
  const synthesizeFn = async () => ({ audio: Buffer.from("a"), contentType: "audio/mpeg" });

  const session = createVoiceSession({ transcribeFn, completeFn, synthesizeFn });
  await session.startSession(() => {}, () => {}, () => {});
  // 32000 bytes => 1 second of 16kHz mono PCM
  await session.sendAudioChunk(makePcmChunk(16000, 5000));
  await session.sendAudioChunk(makePcmChunk(16000, 0));

  const stats = session.getStats();
  assert.ok(stats.audioSeconds >= 1.9, `expected >= 1.9s got ${stats.audioSeconds}`);
  assert.equal(stats.transcriptChars, 2);
  assert.equal(stats.responseChars, 2);
  assert.equal(stats.turns, 1);
  assert.ok(stats.latencyMs >= 0);

  const final = await session.endSession();
  assert.ok(final.endedAt > final.startedAt);
});

test("endSession is idempotent and removes session from registry", async () => {
  const { createVoiceSession, getVoiceSession, _resetForTests } = await import(VOICE_MODULE);
  _resetForTests();
  const session = createVoiceSession({});
  await session.startSession(() => {}, () => {}, () => {});
  assert.ok(getVoiceSession(session.id));
  await session.endSession();
  assert.equal(getVoiceSession(session.id), null);
  // Second call should not throw.
  await session.endSession();
});

test("listActiveSessions returns active session ids", async () => {
  const { createVoiceSession, listActiveSessions, _resetForTests } = await import(VOICE_MODULE);
  _resetForTests();
  const a = createVoiceSession({});
  const b = createVoiceSession({});
  await a.startSession(() => {}, () => {}, () => {});
  await b.startSession(() => {}, () => {}, () => {});
  const ids = listActiveSessions();
  assert.ok(ids.includes(a.id));
  assert.ok(ids.includes(b.id));
  await a.endSession();
  await b.endSession();
  assert.equal(listActiveSessions().length, 0);
});

test("streamingTranscribe yields a final transcript via mock", async () => {
  const { streamingTranscribe } = await import(VOICE_MODULE);
  let calls = 0;
  const transcribeFn = async (_buf, opts) => {
    calls++;
    return { text: opts.isFinal ? "final transcript" : "partial" };
  };
  const chunks = [makePcmChunk(8000, 5000), makePcmChunk(8000, 5000)];
  const out = [];
  for await (const t of streamingTranscribe(chunks, { transcribeFn })) {
    out.push(t);
  }
  assert.ok(out.length >= 1);
  const final = out[out.length - 1];
  assert.equal(final.isFinal, true);
  assert.equal(final.text, "final transcript");
  assert.ok(calls >= 1);
});

test("streamingSynthesize emits audio for sentences progressively", async () => {
  const { streamingSynthesize } = await import(VOICE_MODULE);
  const synthesizeFn = async (sentence) => ({
    audio: Buffer.from(`AUDIO[${sentence}]`),
    contentType: "audio/mpeg",
  });
  async function* tokens() {
    yield "Hello there. ";
    yield "How are you?";
  }
  const out = [];
  for await (const a of streamingSynthesize(tokens(), { synthesizeFn })) {
    out.push(a);
  }
  // Should produce at least 2 audio chunks (one per sentence) plus possibly a final marker.
  assert.ok(out.length >= 2);
  const concatenated = Buffer.concat(out.map((o) => o.audio)).toString();
  assert.ok(concatenated.includes("Hello there"));
  assert.ok(concatenated.includes("How are you?"));
  // Last chunk should be marked final.
  assert.equal(out[out.length - 1].isFinal, true);
});

test("streamingSynthesize handles plain string input", async () => {
  const { streamingSynthesize } = await import(VOICE_MODULE);
  const synthesizeFn = async (sentence) => ({
    audio: Buffer.from(sentence),
    contentType: "audio/mpeg",
  });
  const out = [];
  for await (const a of streamingSynthesize("Just one sentence.", { synthesizeFn })) {
    out.push(a);
  }
  const concatenated = Buffer.concat(out.map((o) => o.audio)).toString();
  assert.ok(concatenated.includes("Just one sentence"));
});

test("HTTP routes: POST /api/v1/voice/sessions creates session", async () => {
  const request = (await import("supertest")).default;
  const express = (await import("express")).default;
  const { mountVoiceRealtimeRoutes } = await import("../routes/voice-realtime.js");
  const { _resetForTests } = await import(VOICE_MODULE);
  _resetForTests();

  const app = express();
  app.use(express.json());
  const apiRoute = (method, path, ...handlers) => app[method](`/api/v1${path}`, ...handlers);
  const apiError = (res, status, code, message) => res.status(status).json({ error: { code, message } });
  const logRequest = (_req, _res, next) => next();
  mountVoiceRealtimeRoutes(app, { apiRoute, apiError, logRequest });

  const create = await request(app).post("/api/v1/voice/sessions").send({});
  assert.equal(create.status, 201);
  assert.ok(create.body.sessionId);
  assert.equal(create.body.wsPath, "/ws/voice");

  const stats = await request(app).get(`/api/v1/voice/sessions/${create.body.sessionId}/stats`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.sessionId, create.body.sessionId);

  const list = await request(app).get("/api/v1/voice/sessions");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.sessions));
  assert.ok(list.body.sessions.includes(create.body.sessionId));

  const del = await request(app).delete(`/api/v1/voice/sessions/${create.body.sessionId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.ok, true);

  const missing = await request(app).get(`/api/v1/voice/sessions/${create.body.sessionId}/stats`);
  assert.equal(missing.status, 404);
});
