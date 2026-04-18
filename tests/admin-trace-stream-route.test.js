/**
 * Route tests for GET /api/admin/traces/:sessionId/stream.
 *
 * Supertest buffers SSE responses awkwardly — some assertions therefore
 * use a raw http.request against a real listening server so we can read
 * individual chunks as they arrive. Supertest is still used for the
 * header / status / invalid-input assertions where buffering doesn't
 * matter.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

async function buildApp() {
  const express = (await import("express")).default;
  const { default: mountAdminTraceStreamRoutes } = await import("../routes/admin-trace-stream.js");

  const app = express();
  app.use(express.json());

  const apiError = (res, status, code, message, hint) =>
    res.status(status).json({ error: message, code, hint: hint || undefined });
  const logRequest = (_req, _res, next) => next();
  const adminAuth = (_req, _res, next) => next();
  const requireScope = () => (_req, _res, next) => next();
  const sanitizeWorkspace = (ws) => String(ws || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);

  mountAdminTraceStreamRoutes(app, { apiError, logRequest, adminAuth, requireScope, sanitizeWorkspace });
  return app;
}

/** Start a real listening server for raw chunk testing. */
async function startServer() {
  const app = await buildApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return { server, port: addr.port };
}

function rawGet(port, path, { timeoutMs = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Accept: "text/event-stream" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), closedByServer: true }));
        res.on("error", reject);
        // Treat first chunks as "initial payload" for the deadline.
        setTimeout(() => {
          try { req.destroy(); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), closedByServer: false });
        }, timeoutMs);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("invalid sessionId returns 400 via supertest", async () => {
  const request = (await import("supertest")).default;
  const app = await buildApp();
  // Express :sessionId won't match empty — hit a path that yields an unsafe id.
  const r = await request(app).get("/api/admin/traces/%20/stream");
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "INVALID_SESSION_ID");
});

test("returns 200 + correct SSE headers + initial data frame", async () => {
  const { server, port } = await startServer();
  try {
    const r = await rawGet(port, "/api/admin/traces/sess-header-test/stream", { timeoutMs: 400 });
    assert.equal(r.status, 200);
    const ct = String(r.headers["content-type"] || "");
    assert.ok(ct.includes("text/event-stream"), "content-type includes text/event-stream");
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.equal(r.headers["connection"], "keep-alive");
    assert.equal(r.headers["x-accel-buffering"], "no");
    // Immediate hello frame should be present.
    assert.ok(r.body.includes("event: hello"), "hello event frame present");
    assert.ok(r.body.includes("data: "), "at least one data: line arrived");
    assert.ok(r.body.includes("sess-header-test"), "hello payload mentions sessionId");
  } finally {
    server.close();
  }
});

test("live-emitted event reaches the stream", async () => {
  const { server, port } = await startServer();
  const { publishAgentRunEvent, getAgentRunEmitter, __resetAgentRunStreamForTests } =
    await import("../lib/agent-run-stream.js");
  __resetAgentRunStreamForTests();

  const sessionId = "sess-live-event";
  // Pre-create the emitter so publishAgentRunEvent finds a registered one
  // (and so the route attaches its listener to the same instance).
  getAgentRunEmitter(sessionId);

  try {
    // Open the stream, then publish after a short delay.
    const gotChunks = [];
    const doneWaiter = new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: `/api/admin/traces/${sessionId}/stream`, method: "GET" },
        (res) => {
          res.on("data", (c) => {
            gotChunks.push(c);
            const all = Buffer.concat(gotChunks).toString("utf8");
            if (all.includes("event: tool.call")) {
              try { req.destroy(); } catch (_) {}
              resolve(all);
            }
          });
          res.on("end", () => resolve(Buffer.concat(gotChunks).toString("utf8")));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
      setTimeout(() => {
        try { req.destroy(); } catch (_) {}
        resolve(Buffer.concat(gotChunks).toString("utf8"));
      }, 1500);
    });

    // Give the route a moment to subscribe, then publish.
    await new Promise((r) => setTimeout(r, 100));
    publishAgentRunEvent(sessionId, "tool.call", { name: "web_search", args: { q: "hi" } });

    const body = await doneWaiter;
    assert.ok(body.includes("event: hello"), "hello frame present");
    assert.ok(body.includes("event: tool.call"), "tool.call frame present");
    assert.ok(body.includes("web_search"), "payload forwarded");
  } finally {
    server.close();
    __resetAgentRunStreamForTests();
  }
});

test("done event closes the stream", async () => {
  const { server, port } = await startServer();
  const { publishAgentRunEvent, getAgentRunEmitter, __resetAgentRunStreamForTests } =
    await import("../lib/agent-run-stream.js");
  __resetAgentRunStreamForTests();

  const sessionId = "sess-done-closes";
  getAgentRunEmitter(sessionId);

  try {
    const result = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = http.request(
        { host: "127.0.0.1", port, path: `/api/admin/traces/${sessionId}/stream`, method: "GET" },
        (res) => {
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ closed: true, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end();
      // Publish "done" after the subscription is wired up.
      setTimeout(() => {
        publishAgentRunEvent(sessionId, "done", { reason: "test" });
      }, 120);
      // Safety timer — if the server doesn't close we detect it.
      setTimeout(() => {
        resolve({ closed: false, body: Buffer.concat(chunks).toString("utf8") });
        try { req.destroy(); } catch (_) {}
      }, 2000);
    });

    assert.equal(result.closed, true, "server closed the stream after done");
    assert.ok(result.body.includes("event: done"), "done event present in body");
  } finally {
    server.close();
    __resetAgentRunStreamForTests();
  }
});

test("supertest confirms status+content-type headers", async () => {
  const request = (await import("supertest")).default;
  const app = await buildApp();
  // supertest buffers, but the initial hello frame should arrive by the time
  // we read the response; we tear down early via a short server timeout.
  const r = await request(app)
    .get("/api/admin/traces/safeSid/stream")
    .buffer(false)
    .parse((res, cb) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        if (buf.includes("event: hello")) {
          try { res.destroy(); } catch (_) {}
          cb(null, buf);
        }
      });
      res.on("end", () => cb(null, buf));
      res.on("error", (e) => cb(e));
    });
  assert.equal(r.status, 200);
  assert.ok(String(r.headers["content-type"] || "").includes("text/event-stream"));
  assert.equal(r.headers["cache-control"], "no-cache");
});
