/**
 * Phase 44.2: Voice cloning tests.
 *
 * Covers:
 *   - Sample upload validation, quota enforcement, persistence
 *   - Training flow with mocked provider
 *   - Synthesis output and content-type
 *   - Provider adapter interface (ElevenLabs + local)
 *   - Routes (upload, list, delete, clone, synthesize)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import request from "supertest";

// Use an isolated storage path for these tests so we don't pollute data/
const TEST_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "voice-clone-test-"));
process.env.STORAGE_PATH = TEST_STORAGE;
process.env.VOICE_MAX_SAMPLES_PER_USER = "5";
process.env.VOICE_MAX_VOICES_PER_USER = "3";

// Build a minimal but valid 32-second 8000Hz mono WAV buffer.
function makeWavBuffer(durationSeconds = 32, sampleRate = 8000) {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const dataSize = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataSize);
  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  // fmt chunk
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // Fill with a quiet sine-ish ramp
  for (let i = 0; i < numSamples; i++) {
    const v = Math.floor(Math.sin(i * 0.01) * 1000);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

const WAV_32S = makeWavBuffer(32);
const WAV_5S = makeWavBuffer(5);

// --- Unit tests for lib/voice-cloning.js ---

test("estimateAudioDuration parses WAV header correctly", async () => {
  const { estimateAudioDuration } = await import("../lib/voice-cloning.js");
  const dur = estimateAudioDuration(WAV_32S, "audio/wav");
  assert.ok(dur >= 31.9 && dur <= 32.1, `expected ~32s, got ${dur}`);
});

test("validateVoiceSample rejects empty buffer", async () => {
  const { validateVoiceSample } = await import("../lib/voice-cloning.js");
  const r = validateVoiceSample(null, "audio/wav");
  assert.equal(r.valid, false);
  assert.match(r.error, /required/);
});

test("validateVoiceSample rejects unsupported MIME", async () => {
  const { validateVoiceSample } = await import("../lib/voice-cloning.js");
  const r = validateVoiceSample(WAV_32S, "video/mp4");
  assert.equal(r.valid, false);
  assert.match(r.error, /Unsupported/);
});

test("validateVoiceSample rejects too-short audio", async () => {
  const { validateVoiceSample } = await import("../lib/voice-cloning.js");
  const r = validateVoiceSample(WAV_5S, "audio/wav");
  assert.equal(r.valid, false);
  assert.match(r.error, /too short/i);
});

test("validateVoiceSample accepts valid 32s WAV", async () => {
  const { validateVoiceSample } = await import("../lib/voice-cloning.js");
  const r = validateVoiceSample(WAV_32S, "audio/wav");
  assert.equal(r.valid, true);
  assert.equal(r.ext, "wav");
  assert.ok(r.duration > 30);
});

test("uploadVoiceSample stores sample and returns metadata", async () => {
  const { uploadVoiceSample, _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("u1");
  const result = await uploadVoiceSample("u1", WAV_32S, { mimeType: "audio/wav", label: "test" });
  assert.ok(result.sampleId.startsWith("sample_"));
  assert.equal(result.format, "wav");
  assert.equal(result.label, "test");
  assert.ok(result.duration > 30);
  assert.equal(result.bytes, WAV_32S.length);
  // Verify file exists on disk
  const userDir = path.join(TEST_STORAGE, "voice-samples", "u1");
  assert.ok(fs.existsSync(userDir));
  assert.ok(fs.existsSync(path.join(userDir, "index.json")));
});

test("listUserSamples returns uploaded samples", async () => {
  const { uploadVoiceSample, listUserSamples, _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("u-list");
  await uploadVoiceSample("u-list", WAV_32S, { mimeType: "audio/wav", label: "first" });
  await uploadVoiceSample("u-list", WAV_32S, { mimeType: "audio/wav", label: "second" });
  const samples = await listUserSamples("u-list");
  assert.equal(samples.length, 2);
  assert.equal(samples[0].label, "first");
  assert.equal(samples[1].label, "second");
});

test("deleteVoiceSample removes sample and file", async () => {
  const { uploadVoiceSample, deleteVoiceSample, listUserSamples, _resetForTests } = await import(
    "../lib/voice-cloning.js"
  );
  _resetForTests("u-del");
  const { sampleId } = await uploadVoiceSample("u-del", WAV_32S, { mimeType: "audio/wav" });
  await deleteVoiceSample("u-del", sampleId);
  const samples = await listUserSamples("u-del");
  assert.equal(samples.length, 0);
});

test("deleteVoiceSample returns NOT_FOUND for unknown id", async () => {
  const { deleteVoiceSample, _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("u-404");
  await assert.rejects(
    () => deleteVoiceSample("u-404", "missing_id"),
    (err) => err.code === "NOT_FOUND"
  );
});

test("uploadVoiceSample enforces per-user sample quota", async () => {
  const { uploadVoiceSample, _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("u-quota");
  // VOICE_MAX_SAMPLES_PER_USER=5
  for (let i = 0; i < 5; i++) {
    await uploadVoiceSample("u-quota", WAV_32S, { mimeType: "audio/wav", label: `s${i}` });
  }
  await assert.rejects(
    () => uploadVoiceSample("u-quota", WAV_32S, { mimeType: "audio/wav" }),
    (err) => err.code === "QUOTA_EXCEEDED"
  );
});

test("trainVoiceModel creates a local cloned voice", async () => {
  const { uploadVoiceSample, trainVoiceModel, listUserVoices, _resetForTests } = await import(
    "../lib/voice-cloning.js"
  );
  _resetForTests("u-train");
  const { sampleId } = await uploadVoiceSample("u-train", WAV_32S, { mimeType: "audio/wav" });
  const voice = await trainVoiceModel("u-train", [sampleId], {
    provider: "local",
    voiceName: "TestVoice",
  });
  assert.ok(voice.voiceId.startsWith("local_"));
  assert.equal(voice.status, "ready");
  assert.equal(voice.provider, "local");
  assert.equal(voice.voiceName, "TestVoice");
  const voices = await listUserVoices("u-train");
  assert.equal(voices.length, 1);
  assert.equal(voices[0].voiceName, "TestVoice");
});

test("trainVoiceModel rejects when sampleIds is empty", async () => {
  const { trainVoiceModel } = await import("../lib/voice-cloning.js");
  await assert.rejects(
    () => trainVoiceModel("u-x", [], { provider: "local", voiceName: "v" }),
    (err) => err.code === "INVALID_INPUT"
  );
});

test("trainVoiceModel rejects when voiceName missing", async () => {
  const { uploadVoiceSample, trainVoiceModel, _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("u-noname");
  const { sampleId } = await uploadVoiceSample("u-noname", WAV_32S, { mimeType: "audio/wav" });
  await assert.rejects(
    () => trainVoiceModel("u-noname", [sampleId], { provider: "local" }),
    (err) => err.code === "INVALID_INPUT"
  );
});

test("trainVoiceModel rejects unknown provider", async () => {
  const { trainVoiceModel } = await import("../lib/voice-cloning.js");
  await assert.rejects(
    () => trainVoiceModel("u-y", ["sid"], { provider: "nope", voiceName: "v" }),
    (err) => err.code === "INVALID_INPUT"
  );
});

test("trainVoiceModel rejects when provider not configured", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  const { uploadVoiceSample, trainVoiceModel, _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("u-nocfg");
  const { sampleId } = await uploadVoiceSample("u-nocfg", WAV_32S, { mimeType: "audio/wav" });
  await assert.rejects(
    () => trainVoiceModel("u-nocfg", [sampleId], { provider: "elevenlabs", voiceName: "v" }),
    (err) => err.code === "PROVIDER_NOT_CONFIGURED"
  );
});

test("trainVoiceModel enforces per-user voice quota", async () => {
  const { uploadVoiceSample, trainVoiceModel, _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("u-vquota");
  const { sampleId } = await uploadVoiceSample("u-vquota", WAV_32S, { mimeType: "audio/wav" });
  // VOICE_MAX_VOICES_PER_USER=3
  for (let i = 0; i < 3; i++) {
    await trainVoiceModel("u-vquota", [sampleId], { provider: "local", voiceName: `v${i}` });
  }
  await assert.rejects(
    () => trainVoiceModel("u-vquota", [sampleId], { provider: "local", voiceName: "v4" }),
    (err) => err.code === "QUOTA_EXCEEDED"
  );
});

test("synthesizeWithClonedVoice with local provider returns audio buffer", async () => {
  const {
    uploadVoiceSample,
    trainVoiceModel,
    synthesizeWithClonedVoice,
    _resetForTests,
  } = await import("../lib/voice-cloning.js");
  _resetForTests("u-synth");
  const { sampleId } = await uploadVoiceSample("u-synth", WAV_32S, { mimeType: "audio/wav" });
  const { voiceId } = await trainVoiceModel("u-synth", [sampleId], {
    provider: "local",
    voiceName: "synthVoice",
  });
  const result = await synthesizeWithClonedVoice(voiceId, "Hello world");
  assert.ok(Buffer.isBuffer(result.audio));
  assert.ok(result.audio.length > 0);
  assert.ok(result.contentType.startsWith("audio/"));
  assert.equal(result.format, "wav");
});

test("synthesizeWithClonedVoice rejects empty text", async () => {
  const { synthesizeWithClonedVoice } = await import("../lib/voice-cloning.js");
  await assert.rejects(
    () => synthesizeWithClonedVoice("voice_x", ""),
    (err) => err.code === "INVALID_INPUT"
  );
});

test("synthesizeWithClonedVoice rejects unknown voice", async () => {
  const { synthesizeWithClonedVoice } = await import("../lib/voice-cloning.js");
  await assert.rejects(
    () => synthesizeWithClonedVoice("missing_voice_id", "hi"),
    (err) => err.code === "NOT_FOUND"
  );
});

test("getVoiceTrainingStatus returns status for local voice", async () => {
  const {
    uploadVoiceSample,
    trainVoiceModel,
    getVoiceTrainingStatus,
    _resetForTests,
  } = await import("../lib/voice-cloning.js");
  _resetForTests("u-status");
  const { sampleId } = await uploadVoiceSample("u-status", WAV_32S, { mimeType: "audio/wav" });
  const { voiceId } = await trainVoiceModel("u-status", [sampleId], {
    provider: "local",
    voiceName: "v",
  });
  const status = await getVoiceTrainingStatus(voiceId);
  assert.equal(status.voiceId, voiceId);
  assert.equal(status.provider, "local");
  assert.equal(status.status, "ready");
});

test("deleteVoice removes voice from registry", async () => {
  const {
    uploadVoiceSample,
    trainVoiceModel,
    deleteVoice,
    listUserVoices,
    _resetForTests,
  } = await import("../lib/voice-cloning.js");
  _resetForTests("u-delv");
  const { sampleId } = await uploadVoiceSample("u-delv", WAV_32S, { mimeType: "audio/wav" });
  const { voiceId } = await trainVoiceModel("u-delv", [sampleId], {
    provider: "local",
    voiceName: "v",
  });
  await deleteVoice("u-delv", voiceId);
  const voices = await listUserVoices("u-delv");
  assert.equal(voices.length, 0);
});

test("deleteVoice rejects when user does not own voice", async () => {
  const { uploadVoiceSample, trainVoiceModel, deleteVoice, _resetForTests } = await import(
    "../lib/voice-cloning.js"
  );
  _resetForTests("u-owner");
  const { sampleId } = await uploadVoiceSample("u-owner", WAV_32S, { mimeType: "audio/wav" });
  const { voiceId } = await trainVoiceModel("u-owner", [sampleId], {
    provider: "local",
    voiceName: "v",
  });
  await assert.rejects(
    () => deleteVoice("u-other", voiceId),
    (err) => err.code === "FORBIDDEN"
  );
});

test("VOICE_PROVIDERS exposes elevenlabs/openai/local config", async () => {
  const { VOICE_PROVIDERS } = await import("../lib/voice-cloning.js");
  assert.equal(VOICE_PROVIDERS.elevenlabs.requiresKey, "ELEVENLABS_API_KEY");
  assert.ok(VOICE_PROVIDERS.elevenlabs.endpoints.train);
  assert.ok(VOICE_PROVIDERS.elevenlabs.endpoints.synthesize);
  assert.equal(VOICE_PROVIDERS.openai.requiresKey, "OPENAI_API_KEY");
  assert.ok(Array.isArray(VOICE_PROVIDERS.openai.presets));
  assert.equal(VOICE_PROVIDERS.local.requiresKey, null);
});

// --- ElevenLabs adapter interface tests (using a fake fetch) ---

test("elevenlabs adapter exports the standard interface", async () => {
  const adapter = await import("../lib/voice-providers/elevenlabs.js");
  assert.equal(typeof adapter.addVoice, "function");
  assert.equal(typeof adapter.synthesize, "function");
  assert.equal(typeof adapter.synthesizeStream, "function");
  assert.equal(typeof adapter.getStatus, "function");
  assert.equal(typeof adapter.listVoices, "function");
  assert.equal(typeof adapter.getVoice, "function");
  assert.equal(typeof adapter.deleteVoice, "function");
});

test("elevenlabs.addVoice throws when API key missing", async () => {
  const original = process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_API_KEY;
  const { addVoice } = await import("../lib/voice-providers/elevenlabs.js");
  await assert.rejects(
    () => addVoice([{ buffer: WAV_32S, mimeType: "audio/wav", filename: "s.wav" }], { voiceName: "v" }),
    (err) => err.code === "PROVIDER_NOT_CONFIGURED"
  );
  if (original) process.env.ELEVENLABS_API_KEY = original;
});

test("elevenlabs.addVoice rejects empty samples", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  const { addVoice } = await import("../lib/voice-providers/elevenlabs.js");
  await assert.rejects(
    () => addVoice([], { voiceName: "v" }),
    (err) => err.code === "INVALID_INPUT"
  );
  delete process.env.ELEVENLABS_API_KEY;
});

test("elevenlabs.addVoice posts multipart form to /v1/voices/add", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key-123";
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ voice_id: "el_abc123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const { addVoice } = await import("../lib/voice-providers/elevenlabs.js");
    const result = await addVoice(
      [{ buffer: WAV_32S, mimeType: "audio/wav", filename: "s.wav" }],
      { voiceName: "Test", description: "desc" }
    );
    assert.equal(result.voiceId, "el_abc123");
    assert.equal(result.status, "ready");
    assert.match(captured.url, /\/v1\/voices\/add$/);
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["xi-api-key"], "test-key-123");
    assert.ok(captured.init.body instanceof FormData);
  } finally {
    global.fetch = originalFetch;
    delete process.env.ELEVENLABS_API_KEY;
  }
});

test("elevenlabs.synthesize returns audio buffer", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key-456";
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer, {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    });
  try {
    const { synthesize } = await import("../lib/voice-providers/elevenlabs.js");
    const result = await synthesize("voice_x", "Hello", { stability: 0.5 });
    assert.ok(Buffer.isBuffer(result.audio));
    assert.equal(result.format, "mp3");
    assert.ok(result.audio.length > 0);
  } finally {
    global.fetch = originalFetch;
    delete process.env.ELEVENLABS_API_KEY;
  }
});

test("elevenlabs.synthesize surfaces non-ok responses", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } });
  try {
    const { synthesize } = await import("../lib/voice-providers/elevenlabs.js");
    await assert.rejects(
      () => synthesize("voice_x", "Hello"),
      (err) => err.code === "BACKEND_ERROR" && err.status === 403
    );
  } finally {
    global.fetch = originalFetch;
    delete process.env.ELEVENLABS_API_KEY;
  }
});

test("elevenlabs.deleteVoice handles 404 gracefully", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("not found", { status: 404 });
  try {
    const { deleteVoice } = await import("../lib/voice-providers/elevenlabs.js");
    const result = await deleteVoice("voice_x");
    assert.equal(result.deleted, true);
  } finally {
    global.fetch = originalFetch;
    delete process.env.ELEVENLABS_API_KEY;
  }
});

// --- Integration tests against routes ---

async function loadApp(env = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env, { VERCEL: "1" });
  const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
  const { default: app } = await import(moduleUrl.href);
  process.env = original;
  // Restore the test storage path so subsequent imports keep using it
  process.env.STORAGE_PATH = TEST_STORAGE;
  process.env.VOICE_MAX_SAMPLES_PER_USER = "5";
  process.env.VOICE_MAX_VOICES_PER_USER = "3";
  return app;
}

test("POST /api/v1/voice/samples returns 400 without audio file", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).post("/api/v1/voice/samples").send();
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test("POST /api/v1/voice/samples uploads a valid sample", async () => {
  const { _resetForTests } = await import("../lib/voice-cloning.js");
  _resetForTests("anonymous");
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/voice/samples")
    .attach("audio", WAV_32S, { filename: "sample.wav", contentType: "audio/wav" })
    .field("label", "route-test");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.sample.sampleId);
  assert.equal(res.body.sample.format, "wav");
});

test("GET /api/v1/voice/samples lists uploaded samples", async () => {
  const { _resetForTests, uploadVoiceSample } = await import("../lib/voice-cloning.js");
  _resetForTests("anonymous");
  await uploadVoiceSample("anonymous", WAV_32S, { mimeType: "audio/wav", label: "x" });
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).get("/api/v1/voice/samples");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.samples));
  assert.equal(res.body.samples.length, 1);
});

test("POST /api/v1/voice/clone trains a voice with local provider", async () => {
  const { _resetForTests, uploadVoiceSample } = await import("../lib/voice-cloning.js");
  _resetForTests("anonymous");
  const { sampleId } = await uploadVoiceSample("anonymous", WAV_32S, { mimeType: "audio/wav" });
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/voice/clone")
    .send({ sampleIds: [sampleId], voiceName: "RouteVoice", provider: "local" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.voice.voiceId);
  assert.equal(res.body.voice.provider, "local");
});

test("POST /api/v1/voice/clone returns 400 without sampleIds", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/voice/clone")
    .send({ voiceName: "v", provider: "local" });
  assert.equal(res.status, 400);
});

test("POST /api/v1/voice/synthesize/:voiceId returns audio bytes", async () => {
  const { _resetForTests, uploadVoiceSample, trainVoiceModel } = await import("../lib/voice-cloning.js");
  _resetForTests("anonymous");
  const { sampleId } = await uploadVoiceSample("anonymous", WAV_32S, { mimeType: "audio/wav" });
  const { voiceId } = await trainVoiceModel("anonymous", [sampleId], {
    provider: "local",
    voiceName: "SynthRoute",
  });
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post(`/api/v1/voice/synthesize/${encodeURIComponent(voiceId)}`)
    .send({ text: "hello there" })
    .buffer(true);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"] || "", /audio\//);
  assert.ok(res.body.length > 0 || res.text?.length > 0);
});

test("POST /api/v1/voice/synthesize returns 400 without text", async () => {
  const { _resetForTests, uploadVoiceSample, trainVoiceModel } = await import("../lib/voice-cloning.js");
  _resetForTests("anonymous");
  const { sampleId } = await uploadVoiceSample("anonymous", WAV_32S, { mimeType: "audio/wav" });
  const { voiceId } = await trainVoiceModel("anonymous", [sampleId], {
    provider: "local",
    voiceName: "v",
  });
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post(`/api/v1/voice/synthesize/${encodeURIComponent(voiceId)}`)
    .send({});
  assert.equal(res.status, 400);
});

test("DELETE /api/v1/voice/voices/:id removes a voice", async () => {
  const { _resetForTests, uploadVoiceSample, trainVoiceModel, listUserVoices } = await import(
    "../lib/voice-cloning.js"
  );
  _resetForTests("anonymous");
  const { sampleId } = await uploadVoiceSample("anonymous", WAV_32S, { mimeType: "audio/wav" });
  const { voiceId } = await trainVoiceModel("anonymous", [sampleId], {
    provider: "local",
    voiceName: "ToDelete",
  });
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).delete(`/api/v1/voice/voices/${encodeURIComponent(voiceId)}`);
  assert.equal(res.status, 200);
  const voices = await listUserVoices("anonymous");
  assert.equal(voices.length, 0);
});

test("GET /api/v1/voice/providers lists providers and configured flag", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).get("/api/v1/voice/providers");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.providers));
  const local = res.body.providers.find((p) => p.name === "local");
  assert.ok(local);
  assert.equal(local.configured, true);
});
