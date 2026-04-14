/**
 * Tests for routes/agent-run-stream.js.
 *
 * Spin up a minimal Express app, inject the standard deps contract
 * (apiRoute / apiError / userAuth / requireScope / logRequest), and assert
 * the SSE endpoint returns 200 with text/event-stream, 401 without auth,
 * 404 for missing sessions, and 403 for non-member workspaces.
 *
 * We intercept EventSource-style SSE frames via supertest's raw buffering
 * response and close the connection from the client side once we've seen
 * enough bytes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import express from "express";
import request from "supertest";

const dir = mkdtempSync(join(tmpdir(), "agent-run-stream-route-"));
const prev = process.env.STORAGE_PATH;
process.env.STORAGE_PATH = dir;

const sessionMod = await import("../lib/agent-session.js");
const streamMod = await import("../lib/agent-run-stream.js");
const { mountAgentRunStreamRoutes } = await import("../routes/agent-run-stream.js");

test.after(() => {
  if (prev === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prev;
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
});

function buildApp({ userId = "test-user", authFail = false } = {}) {
  const app = express();
  app.use(express.json());
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
  mountAgentRunStreamRoutes(app, deps);
  return app;
}

test("SSE endpoint requires auth", async () => {
  streamMod.__resetAgentRunStreamForTests();
  const app = buildApp({ authFail: true });
  const res = await request(app).get("/api/v1/agent/sessions/any-id/stream");
  assert.equal(res.status, 401);
  assert.equal(res.body.code, "AUTH_REQUIRED");
});

test("SSE endpoint 404s for missing session", async () => {
  streamMod.__resetAgentRunStreamForTests();
  const app = buildApp({ userId: "test-user" });
  const res = await request(app).get("/api/v1/agent/sessions/nope/stream");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("SSE endpoint returns 403 when request user does not own the session", async () => {
  streamMod.__resetAgentRunStreamForTests();
  // "default" workspace is present for every user via lib/storage.js.
  const session = await sessionMod.createAgentSession({
    workspace: "default",
    ownerStorageUserId: "owner-user",
    planSummary: "p",
  });
  const app = buildApp({ userId: "intruder-user" });
  const res = await request(app).get(`/api/v1/agent/sessions/${session.id}/stream`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "FORBIDDEN");
});

test("SSE endpoint returns 200 text/event-stream for the owner", async () => {
  streamMod.__resetAgentRunStreamForTests();
  const ownerId = "owner-user-ok";
  const session = await sessionMod.createAgentSession({
    workspace: "default",
    ownerStorageUserId: ownerId,
    planSummary: "p",
  });

  const app = buildApp({ userId: ownerId });

  // Emit a terminal "done" shortly after connect so the stream closes.
  setTimeout(() => {
    try { streamMod.publishAgentRunEvent(session.id, "done", {}); } catch (_) {}
  }, 30);

  const res = await request(app)
    .get(`/api/v1/agent/sessions/${session.id}/stream`)
    .buffer(true)
    .parse((response, cb) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        data += chunk;
        if (data.includes("event: done")) response.destroy();
      });
      response.on("end", () => cb(null, data));
      response.on("close", () => cb(null, data));
    });

  assert.equal(res.status, 200);
  const ct = String(res.headers["content-type"] || "");
  assert.ok(ct.includes("text/event-stream"), `expected text/event-stream, got ${ct}`);
  assert.equal(res.headers["cache-control"], "no-cache, no-transform");
  const body = typeof res.body === "string" ? res.body : (res.text || "");
  assert.ok(body.includes("event: status.change"), `expected initial status.change frame, got: ${body.slice(0, 200)}`);
});
