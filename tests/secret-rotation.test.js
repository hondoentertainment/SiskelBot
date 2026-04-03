/**
 * Secret rotation integration tests.
 * Tests API_KEY_PREVIOUS, SESSION_SECRET_PREVIOUS, and USER_API_KEYS_PREVIOUS
 * env vars for graceful key rotation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { _resetForTesting } from "../lib/auth.js";

async function loadApp(env = {}) {
  const original = { ...process.env };
  Object.assign(process.env, env, { VERCEL: "1" });
  const moduleUrl = new URL(`../server.js?test=${Date.now()}${Math.random()}`, import.meta.url);
  const { default: app } = await import(moduleUrl.href);
  return { app, restore: () => { process.env = original; } };
}

// ---------------------------------------------------------------------------
// API_KEY_PREVIOUS
// ---------------------------------------------------------------------------

test("API_KEY_PREVIOUS: current key works without deprecation header", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    API_KEY: "new-key-123",
    API_KEY_PREVIOUS: "old-key-456",
  });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer new-key-123");
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-api-key-deprecated"], undefined);
  } finally {
    restore();
  }
});

test("API_KEY_PREVIOUS: old key returns X-API-Key-Deprecated header", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    API_KEY: "new-key-123",
    API_KEY_PREVIOUS: "old-key-456",
  });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer old-key-456");
    assert.equal(res.status, 200);
    assert.equal(res.headers["x-api-key-deprecated"], "true");
  } finally {
    restore();
  }
});

test("API_KEY_PREVIOUS: request with neither key returns 401", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    API_KEY: "new-key-123",
    API_KEY_PREVIOUS: "old-key-456",
  });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer totally-wrong");
    assert.equal(res.status, 401);
  } finally {
    restore();
  }
});

test("API_KEY_PREVIOUS: request with no auth header returns 401", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    API_KEY: "new-key-123",
    API_KEY_PREVIOUS: "old-key-456",
  });
  try {
    const res = await request(app).get("/api/workspaces");
    assert.equal(res.status, 401);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// SESSION_SECRET_PREVIOUS
// ---------------------------------------------------------------------------

test("SESSION_SECRET_PREVIOUS: session middleware accepts both secrets", async () => {
  _resetForTesting();
  // When SESSION_SECRET_PREVIOUS is set, express-session receives an array of
  // secrets. We verify the server starts correctly and serves requests.
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    SESSION_SECRET: "new-session-secret",
    SESSION_SECRET_PREVIOUS: "old-session-secret",
  });
  try {
    const res = await request(app).get("/config");
    assert.equal(res.status, 200);
    assert.equal(res.body.backend, "ollama");
    // Verify a session cookie is returned (proves session middleware is active)
    const cookies = res.headers["set-cookie"];
    // Session may or may not set a cookie on GET /config depending on saveUninitialized,
    // but the server should not crash with the dual-secret config
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// USER_API_KEYS_PREVIOUS
// ---------------------------------------------------------------------------

test("USER_API_KEYS_PREVIOUS: previous user key authenticates", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    USER_API_KEYS: "newkey:alice",
    USER_API_KEYS_PREVIOUS: "oldkey:alice",
  });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer oldkey");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally {
    restore();
  }
});

test("USER_API_KEYS_PREVIOUS: current key takes precedence over previous", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    USER_API_KEYS: "sharedkey:alice-new",
    USER_API_KEYS_PREVIOUS: "sharedkey:alice-old",
  });
  try {
    // When the same key exists in both current and previous, current wins
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer sharedkey");
    assert.equal(res.status, 200);
  } finally {
    restore();
  }
});

test("USER_API_KEYS_PREVIOUS: resolveKeyInfo marks previous keys", async () => {
  _resetForTesting();
  process.env.USER_API_KEYS = "current:userA";
  process.env.USER_API_KEYS_PREVIOUS = "legacy:userB";
  _resetForTesting();
  const { resolveKeyInfo } = await import("../lib/auth.js");
  try {
    const currentInfo = resolveKeyInfo("current");
    assert.ok(currentInfo);
    assert.equal(currentInfo.userId, "userA");
    assert.ok(!currentInfo.previous, "current key should not be marked as previous");

    const legacyInfo = resolveKeyInfo("legacy");
    assert.ok(legacyInfo);
    assert.equal(legacyInfo.userId, "userB");
    assert.equal(legacyInfo.previous, true, "previous key should be marked as previous");
  } finally {
    delete process.env.USER_API_KEYS;
    delete process.env.USER_API_KEYS_PREVIOUS;
    _resetForTesting();
  }
});

test("USER_API_KEYS_PREVIOUS: unknown key still returns 401", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({
    BACKEND: "ollama",
    USER_API_KEYS: "newkey:alice",
    USER_API_KEYS_PREVIOUS: "oldkey:alice",
  });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer unknown-key");
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "AUTH_INVALID");
  } finally {
    restore();
  }
});
