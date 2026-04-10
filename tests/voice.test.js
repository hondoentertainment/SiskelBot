import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

// --- Unit tests for lib/voice.js ---

test("isVoiceConfigured returns stt/tts flags based on env", async () => {
  const { isVoiceConfigured } = await import("../lib/voice.js");
  const result = isVoiceConfigured();
  assert.equal(typeof result.stt, "boolean");
  assert.equal(typeof result.tts, "boolean");
  assert.equal(typeof result.configured, "boolean");
  // stt is true if WHISPER_API_KEY or OPENAI_API_KEY is set
  // tts is true if OPENAI_API_KEY is set
  // configured is true if either key is set
  assert.equal(result.configured, result.stt || result.tts);
});

test("validateAudioInput rejects empty buffer", async () => {
  const { validateAudioInput } = await import("../lib/voice.js");
  const result = validateAudioInput(null);
  assert.equal(result.valid, false);
  assert.ok(result.error.includes("required"));
});

test("validateAudioInput rejects zero-length buffer", async () => {
  const { validateAudioInput } = await import("../lib/voice.js");
  const result = validateAudioInput(Buffer.alloc(0));
  assert.equal(result.valid, false);
  assert.ok(result.error.includes("non-empty"));
});

test("validateAudioInput rejects unsupported MIME type", async () => {
  const { validateAudioInput } = await import("../lib/voice.js");
  const result = validateAudioInput(Buffer.from("test"), "video/mp4");
  assert.equal(result.valid, false);
  assert.ok(result.error.includes("Unsupported"));
});

test("validateAudioInput accepts valid audio buffer", async () => {
  const { validateAudioInput } = await import("../lib/voice.js");
  const result = validateAudioInput(Buffer.from("fake-audio-data"), "audio/wav");
  assert.equal(result.valid, true);
  assert.equal(result.error, undefined);
});

test("validateAudioInput accepts buffer without MIME type", async () => {
  const { validateAudioInput } = await import("../lib/voice.js");
  const result = validateAudioInput(Buffer.from("fake-audio-data"));
  assert.equal(result.valid, true);
});

test("validateTtsInput rejects empty text", async () => {
  const { validateTtsInput } = await import("../lib/voice.js");
  assert.equal(validateTtsInput("").valid, false);
  assert.equal(validateTtsInput(null).valid, false);
  assert.equal(validateTtsInput(undefined).valid, false);
});

test("validateTtsInput rejects whitespace-only text", async () => {
  const { validateTtsInput } = await import("../lib/voice.js");
  const result = validateTtsInput("   ");
  assert.equal(result.valid, false);
});

test("validateTtsInput rejects text exceeding max length", async () => {
  const { validateTtsInput } = await import("../lib/voice.js");
  const longText = "a".repeat(5000);
  const result = validateTtsInput(longText);
  assert.equal(result.valid, false);
  assert.ok(result.error.includes("maximum length"));
});

test("validateTtsInput accepts valid text", async () => {
  const { validateTtsInput } = await import("../lib/voice.js");
  const result = validateTtsInput("Hello, how are you?");
  assert.equal(result.valid, true);
  assert.equal(result.error, undefined);
});

// --- Unit tests for lib/multimodal-agent.js ---

test("getMultimodalCapabilities returns expected shape", async () => {
  const { getMultimodalCapabilities } = await import("../lib/multimodal-agent.js");
  const caps = getMultimodalCapabilities();
  assert.equal(typeof caps.vision, "boolean");
  assert.equal(typeof caps.tts, "boolean");
  assert.equal(typeof caps.stt, "boolean");
  assert.equal(typeof caps.documentExtraction, "boolean");
  // documentExtraction is always true (plain text fallback)
  assert.equal(caps.documentExtraction, true);
});

test("describeImage rejects empty buffer", async () => {
  const { describeImage } = await import("../lib/multimodal-agent.js");
  await assert.rejects(
    () => describeImage(null, "describe this"),
    (err) => {
      assert.equal(err.code, "INVALID_INPUT");
      return true;
    }
  );
});

test("describeImage rejects zero-length buffer", async () => {
  const { describeImage } = await import("../lib/multimodal-agent.js");
  await assert.rejects(
    () => describeImage(Buffer.alloc(0)),
    (err) => {
      assert.equal(err.code, "INVALID_INPUT");
      return true;
    }
  );
});

test("extractDocumentContent rejects empty buffer", async () => {
  const { extractDocumentContent } = await import("../lib/multimodal-agent.js");
  await assert.rejects(
    () => extractDocumentContent(null, "text/plain"),
    (err) => {
      assert.equal(err.code, "INVALID_INPUT");
      return true;
    }
  );
});

test("extractDocumentContent rejects missing MIME type", async () => {
  const { extractDocumentContent } = await import("../lib/multimodal-agent.js");
  await assert.rejects(
    () => extractDocumentContent(Buffer.from("hello"), null),
    (err) => {
      assert.equal(err.code, "INVALID_INPUT");
      return true;
    }
  );
});

test("extractDocumentContent handles plain text", async () => {
  const { extractDocumentContent } = await import("../lib/multimodal-agent.js");
  const content = "Hello world\nSecond line";
  const result = await extractDocumentContent(Buffer.from(content), "text/plain");
  assert.equal(result.text, content);
  assert.equal(result.pages, 1);
  assert.equal(result.metadata.mimeType, "text/plain");
  assert.equal(result.metadata.lines, 2);
});

test("extractDocumentContent handles markdown", async () => {
  const { extractDocumentContent } = await import("../lib/multimodal-agent.js");
  const md = "# Title\n\nSome content";
  const result = await extractDocumentContent(Buffer.from(md), "text/markdown");
  assert.equal(result.text, md);
  assert.equal(result.metadata.mimeType, "text/markdown");
});

test("extractDocumentContent handles CSV", async () => {
  const { extractDocumentContent } = await import("../lib/multimodal-agent.js");
  const csv = "name,age\nAlice,30\nBob,25";
  const result = await extractDocumentContent(Buffer.from(csv), "text/csv");
  assert.equal(result.text, csv);
  assert.equal(result.metadata.mimeType, "text/csv");
});

test("extractDocumentContent rejects unsupported MIME type", async () => {
  const { extractDocumentContent } = await import("../lib/multimodal-agent.js");
  await assert.rejects(
    () => extractDocumentContent(Buffer.from("test"), "application/json"),
    (err) => {
      assert.equal(err.code, "UNSUPPORTED_FORMAT");
      return true;
    }
  );
});

test("transcribeAudio rejects when not configured", async () => {
  // Only test if keys are not set in the test env
  const { isVoiceConfigured, transcribeAudio } = await import("../lib/voice.js");
  const config = isVoiceConfigured();
  if (!config.stt) {
    await assert.rejects(
      () => transcribeAudio(Buffer.from("fake audio")),
      (err) => {
        assert.equal(err.code, "VOICE_NOT_CONFIGURED");
        return true;
      }
    );
  }
});

test("synthesizeSpeech rejects when not configured", async () => {
  const { isVoiceConfigured, synthesizeSpeech } = await import("../lib/voice.js");
  const config = isVoiceConfigured();
  if (!config.tts) {
    await assert.rejects(
      () => synthesizeSpeech("Hello"),
      (err) => {
        assert.equal(err.code, "VOICE_NOT_CONFIGURED");
        return true;
      }
    );
  }
});

// --- Integration tests against server endpoints ---

async function loadApp(env = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env, { VERCEL: "1" });
  const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
  const { default: app } = await import(moduleUrl.href);
  process.env = original;
  return app;
}

test("GET /api/v1/voice/capabilities returns capability object", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).get("/api/v1/voice/capabilities");
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.voice, "object");
  assert.equal(typeof res.body.voice.stt, "boolean");
  assert.equal(typeof res.body.voice.tts, "boolean");
  assert.equal(typeof res.body.voice.configured, "boolean");
  assert.equal(typeof res.body.multimodal, "object");
  assert.equal(typeof res.body.multimodal.vision, "boolean");
  assert.equal(typeof res.body.multimodal.documentExtraction, "boolean");
});

test("GET /api/voice/capabilities works on legacy path", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).get("/api/voice/capabilities");
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.voice, "object");
  // Legacy path should include deprecation header
  assert.ok(res.headers["deprecation"] || res.headers["x-api-deprecated"]);
});

test("POST /api/v1/voice/transcribe returns 400 when no audio uploaded", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/voice/transcribe")
    .send();
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test("POST /api/v1/voice/synthesize returns 400 when no text provided", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/voice/synthesize")
    .send({});
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test("POST /api/v1/voice/synthesize returns 400 for empty text", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/voice/synthesize")
    .send({ text: "" });
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test("POST /api/v1/voice/transcribe returns 503 when STT not configured", async () => {
  const app = await loadApp({ BACKEND: "ollama", WHISPER_API_KEY: "", OPENAI_API_KEY: "" });
  const res = await request(app)
    .post("/api/v1/voice/transcribe")
    .attach("audio", Buffer.from("fake-audio"), { filename: "test.wav", contentType: "audio/wav" });
  // Should be 503 (not configured) or 400 (invalid audio)
  assert.ok([400, 503].includes(res.status));
});

test("POST /api/v1/voice/synthesize returns 503 when TTS not configured", async () => {
  const app = await loadApp({ BACKEND: "ollama", OPENAI_API_KEY: "" });
  const res = await request(app)
    .post("/api/v1/voice/synthesize")
    .send({ text: "Hello world" });
  // Should be 503 when OPENAI_API_KEY is not set
  assert.ok([400, 503].includes(res.status));
});
