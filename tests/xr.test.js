/**
 * Phase 49.1: WebXR client route tests.
 *
 * WebXR rendering is inherently browser-only, so these tests exercise the
 * server-side capability hints, asset catalog, and session tracking surface
 * of routes/xr.js with supertest. Each test uses its own STORAGE_PATH via
 * mkdtempSync so no state leaks between runs (even though the store itself
 * is in-memory, this keeps the convention consistent with other suites).
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-xr-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  mountXrRoutes,
  createXrSessionStore,
  __setXrStore,
  __resetXrStore,
} = await import("../routes/xr.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function buildApp({ userId = "test-user" } = {}) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });

  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    logRequest: (_req, _res, next) => next(),
    userAuth: (_req, _res, next) => next(),
    requireScope: () => (_req, _res, next) => next(),
  };

  __resetXrStore();
  mountXrRoutes(app, deps);
  return app;
}

test.beforeEach(() => {
  __resetXrStore();
});

// ─── /xr/capabilities ────────────────────────────────────────────────────────

test("GET /xr/capabilities returns webxr and renderer hints", async () => {
  const app = buildApp();
  const res = await request(app).get("/api/v1/xr/capabilities");

  assert.equal(res.status, 200);
  assert.equal(res.body._version, 1);
  assert.ok(res.body.webxr);
  assert.ok(Array.isArray(res.body.webxr.supportedModes));
  assert.ok(res.body.webxr.supportedModes.includes("immersive-vr"));
  assert.ok(res.body.webxr.supportedModes.includes("immersive-ar"));
  assert.ok(res.body.webxr.supportedModes.includes("inline"));
  assert.equal(res.body.renderer.engine, "inline-webgl");
  assert.equal(res.body.renderer.threejs, false);
});

// ─── /xr/assets ──────────────────────────────────────────────────────────────

test("GET /xr/assets returns an asset array", async () => {
  const app = buildApp();
  const res = await request(app).get("/api/v1/xr/assets");

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.assets));
  assert.equal(res.body.count, res.body.assets.length);
  // Each asset should have at minimum an id and a kind
  for (const asset of res.body.assets) {
    assert.equal(typeof asset.id, "string");
    assert.equal(typeof asset.kind, "string");
  }
});

// ─── /xr/session (create) ────────────────────────────────────────────────────

test("POST /xr/session creates a session record", async () => {
  const app = buildApp({ userId: "alice" });
  const res = await request(app)
    .post("/api/v1/xr/session")
    .send({
      mode: "immersive-vr",
      device: "Quest 3",
      features: ["local-floor", "hand-tracking"],
      metadata: { roomSize: "2x2" },
    });

  assert.equal(res.status, 201);
  assert.ok(res.body.session.id.startsWith("xrses_"));
  assert.equal(res.body.session.userId, "alice");
  assert.equal(res.body.session.mode, "immersive-vr");
  assert.equal(res.body.session.device, "Quest 3");
  assert.deepEqual(res.body.session.features, ["local-floor", "hand-tracking"]);
  assert.equal(res.body.session.endedAt, null);
  assert.equal(res.body.session.durationMs, null);
});

test("POST /xr/session rejects an unknown mode", async () => {
  const app = buildApp();
  const res = await request(app)
    .post("/api/v1/xr/session")
    .send({ mode: "immersive-holodeck" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_INPUT");
});

test("POST /xr/session defaults mode to inline when omitted", async () => {
  const app = buildApp();
  const res = await request(app).post("/api/v1/xr/session").send({});
  assert.equal(res.status, 201);
  assert.equal(res.body.session.mode, "inline");
});

// ─── /xr/session/:id/end ─────────────────────────────────────────────────────

test("POST /xr/session/:id/end marks the session ended and computes duration", async () => {
  const app = buildApp({ userId: "bob" });
  const createRes = await request(app)
    .post("/api/v1/xr/session")
    .send({ mode: "inline" });
  const id = createRes.body.session.id;

  // Ensure durationMs can be a positive integer even on fast clocks.
  await new Promise((r) => setTimeout(r, 5));

  const endRes = await request(app).post(`/api/v1/xr/session/${id}/end`).send({});
  assert.equal(endRes.status, 200);
  assert.equal(endRes.body.session.id, id);
  assert.ok(endRes.body.session.endedAt !== null);
  assert.equal(typeof endRes.body.session.durationMs, "number");
  assert.ok(endRes.body.session.durationMs >= 0);
});

test("POST /xr/session/:id/end returns 404 for unknown session", async () => {
  const app = buildApp();
  const res = await request(app).post("/api/v1/xr/session/xrses_missing/end").send({});
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

// ─── /xr/sessions (list) ─────────────────────────────────────────────────────

test("GET /xr/sessions lists only this user's sessions", async () => {
  // Use a shared store across two app instances so we can seed sessions
  // belonging to a different user and confirm the filter works.
  const store = createXrSessionStore();
  __setXrStore(store);
  store.create("carol", { mode: "immersive-vr" });
  store.create("dave", { mode: "inline" });
  store.create("carol", { mode: "inline" });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "carol";
    next();
  });
  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message) {
      return res.status(status).json({ error: message, code });
    },
    logRequest: (_req, _res, next) => next(),
    userAuth: (_req, _res, next) => next(),
    requireScope: () => (_req, _res, next) => next(),
  };
  mountXrRoutes(app, deps);

  const res = await request(app).get("/api/v1/xr/sessions");
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 2);
  for (const s of res.body.sessions) {
    assert.equal(s.userId, "carol");
  }
});

// ─── /xr/session/:id (fetch) ─────────────────────────────────────────────────

test("GET /xr/session/:id returns the session when owned by the caller", async () => {
  const app = buildApp({ userId: "eve" });
  const createRes = await request(app)
    .post("/api/v1/xr/session")
    .send({ mode: "immersive-ar", device: "Vision Pro" });
  const id = createRes.body.session.id;

  const res = await request(app).get(`/api/v1/xr/session/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.session.id, id);
  assert.equal(res.body.session.mode, "immersive-ar");
  assert.equal(res.body.session.device, "Vision Pro");
});

test("GET /xr/session/:id returns 404 for unknown session id", async () => {
  const app = buildApp();
  const res = await request(app).get("/api/v1/xr/session/xrses_does_not_exist");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("GET /xr/session/:id returns 403 when another user owns the session", async () => {
  const store = createXrSessionStore();
  __setXrStore(store);
  const owned = store.create("alice", { mode: "inline" });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "mallory";
    next();
  });
  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message) {
      return res.status(status).json({ error: message, code });
    },
    logRequest: (_req, _res, next) => next(),
    userAuth: (_req, _res, next) => next(),
    requireScope: () => (_req, _res, next) => next(),
  };
  mountXrRoutes(app, deps);

  const res = await request(app).get(`/api/v1/xr/session/${owned.id}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "FORBIDDEN");
});

// ─── store unit tests ────────────────────────────────────────────────────────

test("createXrSessionStore() isolates records per instance", () => {
  const a = createXrSessionStore();
  const b = createXrSessionStore();
  a.create("u1", { mode: "inline" });
  assert.equal(a._all().length, 1);
  assert.equal(b._all().length, 0);
});
