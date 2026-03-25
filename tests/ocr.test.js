import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

async function loadApp(env = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env, { VERCEL: "1" });
  const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
  const { default: app } = await import(moduleUrl.href);
  process.env = original;
  return app;
}

// --- Unit tests for lib/ocr.js ---

test("isSupportedMime accepts PNG, JPG, TIFF, BMP, PDF", async () => {
  const { isSupportedMime } = await import("../lib/ocr.js");
  assert.ok(isSupportedMime("image/png"));
  assert.ok(isSupportedMime("image/jpeg"));
  assert.ok(isSupportedMime("image/tiff"));
  assert.ok(isSupportedMime("image/bmp"));
  assert.ok(isSupportedMime("application/pdf"));
  assert.equal(isSupportedMime("text/plain"), false);
  assert.equal(isSupportedMime("application/json"), false);
});

test("extractText rejects unsupported MIME type", async () => {
  const { extractText } = await import("../lib/ocr.js");
  await assert.rejects(
    () => extractText(Buffer.from("hello"), "text/plain"),
    (err) => {
      assert.equal(err.code, "UNSUPPORTED_FORMAT");
      return true;
    }
  );
});

// --- Integration tests against server endpoints ---

test("POST /api/ocr returns 400 when no file is uploaded", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/ocr")
    .send();
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});

test("POST /api/ocr returns 415 for unsupported file type", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/ocr")
    .attach("file", Buffer.from("{}"), { filename: "data.json", contentType: "application/json" });
  assert.equal(res.status, 415);
  assert.equal(res.body.code, "UNSUPPORTED_FORMAT");
});

test("POST /api/ocr processes a small PNG successfully", async () => {
  const app = await loadApp({ BACKEND: "ollama" });

  // Create a minimal valid 1x1 white PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64"
  );

  const res = await request(app)
    .post("/api/ocr")
    .attach("file", png, { filename: "test.png", contentType: "image/png" });

  assert.equal(res.status, 200);
  assert.equal(typeof res.body.text, "string");
  assert.equal(res.body.pages, 1);
  assert.equal(typeof res.body.confidence, "number");
  assert.ok(res.body.confidence >= 0 && res.body.confidence <= 1, "confidence should be between 0 and 1");
});

test("POST /api/v1/ocr also works (versioned route)", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/ocr")
    .send();
  // Should be 400 (no file), not 404 — proves route is registered
  assert.equal(res.status, 400);
});
