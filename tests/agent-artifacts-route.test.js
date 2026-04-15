/**
 * Tests for routes/agent-artifacts.js.
 *
 * Mounts the route module on a minimal Express app with the same deps
 * contract used by routes/agent-run-stream.js. Covers:
 *
 *   - POST JSON (contentBase64 + content string)
 *   - POST multipart/form-data
 *   - GET list
 *   - GET content (correct MIME and body bytes)
 *   - Auth required
 *   - Workspace-access / ownership gate
 *   - 404 for unknown artifact / session
 *   - DELETE
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import request from "supertest";

const dir = mkdtempSync(join(tmpdir(), "agent-artifacts-route-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const sessionMod = await import("../lib/agent-session.js");
const streamMod = await import("../lib/agent-run-stream.js");
const artifactsMod = await import("../lib/agent-artifacts.js");
const { mountAgentArtifactRoutes } = await import("../routes/agent-artifacts.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

function buildApp({ userId = "owner-user", authFail = false } = {}) {
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  const deps = {
    apiRoute(method, path, ...handlers) {
      app[method](`/api/v1${path}`, ...handlers);
    },
    apiError(res, status, code, message, hint) {
      return res.status(status).json({ error: message, code, hint });
    },
    userAuth(req, res, next) {
      if (authFail) return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
      req.userId = userId;
      next();
    },
    requireScope: () => (req, res, next) => next(),
    logRequest: (req, res, next) => next(),
  };
  mountAgentArtifactRoutes(app, deps);
  return app;
}

async function freshSession(owner = "owner-user") {
  await artifactsMod.__resetArtifactsForTests();
  streamMod.__resetAgentRunStreamForTests();
  return sessionMod.createAgentSession({
    workspace: "default",
    ownerStorageUserId: owner,
    planSummary: "p",
  });
}

test("POST /agent/sessions/:id/artifacts requires auth", async () => {
  const session = await freshSession();
  const app = buildApp({ authFail: true });
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({ name: "x.txt", mime: "text/plain", contentBase64: Buffer.from("hi").toString("base64") });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("POST /agent/sessions/:id/artifacts (JSON contentBase64) creates an artifact", async () => {
  const session = await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const payload = "hello artifact world";
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({
      name: "note.txt",
      mime: "text/plain",
      contentBase64: Buffer.from(payload, "utf8").toString("base64"),
    });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "note.txt");
  assert.equal(res.body.mime, "text/plain");
  assert.equal(res.body.sizeBytes, Buffer.byteLength(payload, "utf8"));
  assert.equal(typeof res.body.id, "string");
  assert.ok(!("inline" in res.body), "response must not include inline bytes");
});

test("POST JSON with content string also works", async () => {
  const session = await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({ name: "inline.txt", mime: "text/plain", content: "plaintext body" });
  assert.equal(res.status, 201);
  assert.equal(res.body.sizeBytes, "plaintext body".length);
});

test("POST multipart/form-data creates an artifact", async () => {
  const session = await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const buf = Buffer.from("multipart payload", "utf8");
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .field("name", "up.txt")
    .field("mime", "text/plain")
    .attach("file", buf, { filename: "up.txt", contentType: "text/plain" });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "up.txt");
  assert.equal(res.body.mime, "text/plain");
  assert.equal(res.body.sizeBytes, buf.length);
});

test("GET /agent/sessions/:id/artifacts returns the list", async () => {
  const session = await freshSession();
  const app = buildApp({ userId: "owner-user" });
  await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({ name: "a.txt", mime: "text/plain", content: "a" });
  await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({ name: "b.txt", mime: "text/plain", content: "b" });
  const res = await request(app).get(`/api/v1/agent/sessions/${session.id}/artifacts`);
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(res.body.items), true);
  assert.equal(res.body.total, 2);
  const names = res.body.items.map((x) => x.name).sort();
  assert.deepEqual(names, ["a.txt", "b.txt"]);
});

test("GET /agent/artifacts/:id streams bytes with recorded MIME", async () => {
  const session = await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG signature
  const created = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({ name: "icon.png", mime: "image/png", contentBase64: buf.toString("base64") });
  assert.equal(created.status, 201);
  const getRes = await request(app)
    .get(`/api/v1/agent/artifacts/${created.body.id}`)
    .buffer(true)
    .parse((response, cb) => {
      const chunks = [];
      response.on("data", (c) => chunks.push(c));
      response.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers["content-type"], "image/png");
  assert.equal(getRes.headers["x-artifact-id"], created.body.id);
  const body = getRes.body;
  assert.ok(Buffer.isBuffer(body), "body is a Buffer");
  assert.deepEqual(Array.from(body), Array.from(buf));
});

test("GET /agent/artifacts/:id 404s for unknown id", async () => {
  await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const res = await request(app).get(`/api/v1/agent/artifacts/00000000-0000-0000-0000-000000000000`);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("workspace-access enforcement: non-owner gets 403", async () => {
  const session = await freshSession("owner-user");
  // Pre-create an artifact as the owner.
  {
    const ownerApp = buildApp({ userId: "owner-user" });
    const up = await request(ownerApp)
      .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
      .send({ name: "secret.txt", mime: "text/plain", content: "top-secret" });
    assert.equal(up.status, 201);
    // Test list + read denial with a different user.
    const intruderApp = buildApp({ userId: "intruder-user" });
    const listRes = await request(intruderApp).get(`/api/v1/agent/sessions/${session.id}/artifacts`);
    assert.equal(listRes.status, 403);
    assert.equal(listRes.body.code, "FORBIDDEN");
    const readRes = await request(intruderApp).get(`/api/v1/agent/artifacts/${up.body.id}`);
    assert.equal(readRes.status, 403);
    assert.equal(readRes.body.code, "FORBIDDEN");
    const postRes = await request(intruderApp)
      .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
      .send({ name: "evil.txt", mime: "text/plain", content: "bad" });
    assert.equal(postRes.status, 403);
    assert.equal(postRes.body.code, "FORBIDDEN");
  }
});

test("DELETE removes an artifact", async () => {
  const session = await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const created = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({ name: "gone.txt", mime: "text/plain", content: "bye" });
  assert.equal(created.status, 201);
  const delRes = await request(app).delete(`/api/v1/agent/artifacts/${created.body.id}`);
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.ok, true);
  const missRes = await request(app).get(`/api/v1/agent/artifacts/${created.body.id}`);
  assert.equal(missRes.status, 404);
  const delAgain = await request(app).delete(`/api/v1/agent/artifacts/${created.body.id}`);
  assert.equal(delAgain.status, 404);
});

test("POST 404s for unknown session id", async () => {
  await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const res = await request(app)
    .post(`/api/v1/agent/sessions/does-not-exist/artifacts`)
    .send({ name: "x.txt", mime: "text/plain", content: "x" });
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("POST rejects missing content with 400 INVALID_CONTENT", async () => {
  const session = await freshSession();
  const app = buildApp({ userId: "owner-user" });
  const res = await request(app)
    .post(`/api/v1/agent/sessions/${session.id}/artifacts`)
    .send({ name: "x.txt", mime: "text/plain" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "INVALID_CONTENT");
});
