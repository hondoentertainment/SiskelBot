/**
 * Phase 14: User authentication tests.
 * Tests userAuth middleware via server endpoints (integration-style).
 * Must keep env until request completes (auth reads process.env in request handler).
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

test("userAuth allows anonymous when USER_API_KEYS not set", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({ USER_API_KEYS: "", BACKEND: "ollama" });
  try {
    const res = await request(app).get("/api/workspaces");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.items.length >= 1, "default workspace should exist");
  } finally {
    restore();
  }
});

test("userAuth returns 401 when USER_API_KEYS set and no key", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({ USER_API_KEYS: "k1:u1", BACKEND: "ollama" });
  try {
    const res = await request(app).get("/api/workspaces");
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "AUTH_REQUIRED");
    assert.match(res.body.hint, /Authorization| x-user-api-key/i);
  } finally {
    restore();
  }
});

test("userAuth returns 401 when invalid key provided", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({ USER_API_KEYS: "k1:u1", BACKEND: "ollama" });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer badkey");
    assert.equal(res.status, 401);
    assert.equal(res.body.code, "AUTH_INVALID");
  } finally {
    restore();
  }
});

test("userAuth allows when valid Bearer token", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({ USER_API_KEYS: "k1:u1", BACKEND: "ollama" });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer k1");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally {
    restore();
  }
});

test("userAuth allows when valid x-user-api-key header", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({ USER_API_KEYS: "mykey:user42", BACKEND: "ollama" });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("x-user-api-key", "mykey");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally {
    restore();
  }
});

// Phase 30: API key scopes
test("USER_API_KEYS with scopes format - key:userId:scopes", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({ USER_API_KEYS: "scopedkey:alice:read,embed", BACKEND: "ollama" });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer scopedkey");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally {
    restore();
  }
});

test("Keys without scopes default to read,write (backward compat)", async () => {
  _resetForTesting();
  const { app, restore } = await loadApp({ USER_API_KEYS: "plainkey: Bob", BACKEND: "ollama" });
  try {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer plainkey");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  } finally {
    restore();
  }
});

test("resolveKeyInfo returns userId and scopes", async () => {
  _resetForTesting();
  const { resolveKeyInfo } = await import("../lib/auth.js");
  process.env.USER_API_KEYS = "k:u:read";
  const { _resetForTesting: reset } = await import("../lib/auth.js");
  reset();
  try {
    const info = resolveKeyInfo("k");
    assert.ok(info);
    assert.equal(info.userId, "u");
    assert.deepEqual(info.scopes, ["read"]);
  } finally {
    reset();
  }
});
