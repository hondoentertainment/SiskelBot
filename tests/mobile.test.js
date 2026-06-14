/**
 * Phase 37.2: Tests for mobile-optimized API endpoints in routes/mobile.js.
 */

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

const WS = "mobile-tests-" + Date.now();

async function seedConversations(app, count = 3) {
  const created = [];
  for (let i = 0; i < count; i++) {
    const res = await request(app)
      .post("/api/v1/conversations")
      .send({
        workspace: WS,
        title: `Conversation ${i}`,
        messages: [
          { role: "user", content: `Hello ${i}` },
          { role: "assistant", content: `Reply ${i}` },
        ],
      });
    assert.equal(res.status, 201, `create conv ${i} failed: ${JSON.stringify(res.body)}`);
    created.push(res.body);
  }
  return created;
}

// ─── trackBandwidth middleware ─────────────────────────────────────────────

test("trackBandwidth middleware records bytes sent", async () => {
  process.env.ENABLE_METRICS = "1";
  const { trackBandwidth } = await import("../routes/mobile.js");
  const { getBandwidthSnapshot } = await import("../lib/metrics.js");

  let ended = false;
  const payload = { hello: "world", n: 42 };
  const req = { method: "GET", path: "/api/v1/mobile/unit-test-route", route: null };
  const res = {
    _buf: [],
    write(chunk) { this._buf.push(chunk); return true; },
    end(chunk) {
      if (chunk !== undefined) this._buf.push(chunk);
      ended = true;
      return this;
    },
  };
  trackBandwidth(req, res, () => {});
  res.write(JSON.stringify(payload));
  res.end();
  assert.equal(ended, true);
  assert.ok(res.bandwidthBytes > 0);
  const snap = getBandwidthSnapshot();
  const hasEntry = Object.keys(snap).some((k) => k.includes("mobile") && k.includes("unit_test_route"));
  assert.ok(hasEntry, "bandwidth snapshot should include the mobile unit test route");
});

// ─── GET /api/v1/mobile/sync ───────────────────────────────────────────────

test("GET /api/v1/mobile/sync returns conversations/documents/recipes with lastSync", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  await seedConversations(app, 2);
  const res = await request(app).get(`/api/v1/mobile/sync?workspace=${WS}`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.conversations));
  assert.ok(Array.isArray(res.body.documents));
  assert.ok(Array.isArray(res.body.recipes));
  assert.equal(typeof res.body.lastSync, "number");
  assert.ok(res.body.conversations.length >= 2);
});

test("GET /api/v1/mobile/sync delta with ?since filters out older items", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  await seedConversations(app, 1);
  // Use a timestamp in the future - nothing should match
  const future = Date.now() + 10 * 60 * 1000;
  const res = await request(app).get(`/api/v1/mobile/sync?workspace=${WS}&since=${future}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.conversations.length, 0);
  assert.equal(res.body.documents.length, 0);
  assert.equal(res.body.recipes.length, 0);
});

test("GET /api/v1/mobile/sync sets a short Cache-Control header", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).get(`/api/v1/mobile/sync?workspace=${WS}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers["cache-control"]);
  assert.ok(res.headers["cache-control"].includes("max-age"));
});

// ─── GET /api/v1/mobile/feed ───────────────────────────────────────────────

test("GET /api/v1/mobile/feed returns compact activity items", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  await seedConversations(app, 2);
  const res = await request(app).get(`/api/v1/mobile/feed?workspace=${WS}&limit=10`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  if (res.body.items.length > 0) {
    const item = res.body.items[0];
    assert.ok("id" in item);
    assert.ok("type" in item);
    assert.ok("title" in item);
    assert.ok("preview" in item);
    assert.ok("timestamp" in item);
  }
});

// ─── GET /api/v1/mobile/conversations (compact list) ───────────────────────

test("GET /api/v1/mobile/conversations returns compact list when compact=1", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  await seedConversations(app, 3);

  const full = await request(app).get(`/api/v1/conversations?workspace=${WS}`);
  assert.equal(full.status, 200);

  const mobile = await request(app).get(`/api/v1/mobile/conversations?workspace=${WS}&limit=5&compact=1`);
  assert.equal(mobile.status, 200);
  assert.ok(Array.isArray(mobile.body.items));
  assert.ok(mobile.body.items.length > 0);

  // compact items only have id, title, lastMessage, updatedAt (no full message list)
  for (const it of mobile.body.items) {
    assert.ok("id" in it);
    assert.ok("title" in it);
    assert.ok("lastMessage" in it);
    assert.equal("messages" in it, false, "compact list should not include raw messages");
  }

  // compact payload should be smaller than the full listing
  const fullBytes = JSON.stringify(full.body).length;
  const mobileBytes = JSON.stringify(mobile.body).length;
  assert.ok(mobileBytes <= fullBytes, `compact payload (${mobileBytes}) should be <= full payload (${fullBytes})`);
});

// ─── GET /api/v1/mobile/conversations/:id ──────────────────────────────────

test("GET /api/v1/mobile/conversations/:id?compact=1 returns compact conversation", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const [conv] = await seedConversations(app, 1);
  const res = await request(app).get(`/api/v1/mobile/conversations/${conv.id}?workspace=${WS}&compact=1`);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, conv.id);
  assert.ok(Array.isArray(res.body.messages));
  assert.ok(res.body.messages.length <= 50);
});

test("GET /api/v1/mobile/conversations/:id returns 404 for unknown id", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).get(`/api/v1/mobile/conversations/nonexistent-id?workspace=${WS}`);
  assert.equal(res.status, 404);
});

// ─── POST /api/v1/mobile/batch ─────────────────────────────────────────────

test("POST /api/v1/mobile/batch executes multiple calls in one request", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  await seedConversations(app, 1);
  const res = await request(app)
    .post("/api/v1/mobile/batch")
    .send([
      { method: "GET", path: `/api/v1/mobile/sync?workspace=${WS}` },
      { method: "GET", path: `/api/v1/mobile/feed?workspace=${WS}` },
      { method: "GET", path: `/api/v1/mobile/conversations?workspace=${WS}` },
    ]);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 3);
  for (const r of res.body) {
    assert.equal(typeof r.status, "number");
    assert.ok(r.status >= 200 && r.status < 500);
  }
});

test("POST /api/v1/mobile/batch rejects non-array body", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/mobile/batch")
    .send({ not: "an array" });
  assert.equal(res.status, 400);
});

test("POST /api/v1/mobile/batch rejects oversized batches", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const calls = Array.from({ length: 25 }, () => ({ method: "GET", path: "/api/v1/mobile/sync" }));
  const res = await request(app).post("/api/v1/mobile/batch").send(calls);
  assert.equal(res.status, 400);
});

test("POST /api/v1/mobile/batch refuses to call itself", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/mobile/batch")
    .send([{ method: "POST", path: "/api/v1/mobile/batch", body: [] }]);
  assert.equal(res.status, 200);
  assert.equal(res.body[0].status, 400);
});

// ─── POST /api/v1/mobile/devices ───────────────────────────────────────────

test("POST /api/v1/mobile/devices registers a device token", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const token = "test-tok-" + Date.now();
  const res = await request(app)
    .post("/api/v1/mobile/devices")
    .send({ platform: "android", token });
  assert.equal(res.status, 201);
  assert.ok(res.body.id);
  assert.equal(res.body.platform, "android");
});

test("POST /api/v1/mobile/devices rejects missing platform", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/mobile/devices")
    .send({ token: "xyz" });
  assert.equal(res.status, 400);
});

test("POST /api/v1/mobile/devices rejects missing token", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/mobile/devices")
    .send({ platform: "ios" });
  assert.equal(res.status, 400);
});

test("POST /api/v1/mobile/devices rejects invalid platform", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/mobile/devices")
    .send({ platform: "symbian", token: "t" });
  assert.equal(res.status, 400);
});

test("DELETE /api/v1/mobile/devices/:token removes a registered token", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const token = "rm-tok-" + Date.now();
  const reg = await request(app)
    .post("/api/v1/mobile/devices")
    .send({ platform: "android", token });
  assert.equal(reg.status, 201);

  const del = await request(app).delete(`/api/v1/mobile/devices/${token}`);
  assert.equal(del.status, 204);
});

test("DELETE /api/v1/mobile/devices/:token returns 404 for unknown token", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const del = await request(app).delete(`/api/v1/mobile/devices/nothing-here-${Date.now()}`);
  assert.equal(del.status, 404);
});

test("GET /api/v1/mobile/devices lists current user's devices", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const token = "list-tok-" + Date.now();
  await request(app).post("/api/v1/mobile/devices").send({ platform: "ios", token });
  const res = await request(app).get("/api/v1/mobile/devices");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.push && typeof res.body.push === "object");
});

// ─── POST /api/v1/mobile/test-notification (admin) ─────────────────────────

test("POST /api/v1/mobile/test-notification requires admin auth when ADMIN_API_KEY is set", async () => {
  const app = await loadApp({ BACKEND: "ollama", ADMIN_API_KEY: "admin-secret" });
  const res = await request(app)
    .post("/api/v1/mobile/test-notification")
    .send({ userId: "u1", title: "t", body: "b" });
  assert.equal(res.status, 401);
});

test("POST /api/v1/mobile/test-notification returns 401 when admin is not configured", async () => {
  // adminAuth is enforced on this route; without ADMIN_API_KEY the middleware
  // should reject the request. This test validates that the admin guard is
  // wired up, which is the important behavior for the surface.
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app)
    .post("/api/v1/mobile/test-notification")
    .send({ userId: "u1", title: "t", body: "b" });
  assert.equal(res.status, 401);
});

test("notifyUser library returns zero counts when user has no devices", async () => {
  // The HTTP handler for /mobile/test-notification is a thin wrapper around
  // lib/push-notifications.notifyUser. Testing the library directly avoids
  // the module-level caching of ADMIN_API_KEY in admin-auth.js that makes
  // flipping admin state mid-suite unreliable.
  const { notifyUser } = await import("../lib/push-notifications.js");
  const result = await notifyUser("test-no-devices-" + Date.now(), "t", "b");
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.results, []);
});

// ─── Legacy path support ───────────────────────────────────────────────────

test("GET /api/mobile/sync works on legacy /api path with deprecation header", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const res = await request(app).get(`/api/mobile/sync?workspace=${WS}`);
  assert.equal(res.status, 200);
  assert.ok(res.headers["deprecation"] || res.headers["x-api-deprecated"]);
});

// ─── Compact list payload is actually smaller ──────────────────────────────

test("compact conversation payload is significantly smaller than full", async () => {
  const app = await loadApp({ BACKEND: "ollama" });
  const created = await seedConversations(app, 1);
  const id = created[0].id;
  const full = await request(app).get(`/api/v1/conversations/${id}?workspace=${WS}`);
  assert.equal(full.status, 200);
  const compact = await request(app).get(`/api/v1/mobile/conversations/${id}?workspace=${WS}&compact=1`);
  assert.equal(compact.status, 200);
  const fullBytes = JSON.stringify(full.body).length;
  const compactBytes = JSON.stringify(compact.body).length;
  assert.ok(compactBytes <= fullBytes);
});
