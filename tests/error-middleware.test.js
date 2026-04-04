/**
 * Error middleware tests.
 * Tests the 404 handler and error handler from lib/error-middleware.js.
 * Uses a minimal Express app to avoid full server loading issues.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";
import { randomUUID } from "node:crypto";
import { errorMiddleware, errorHandler } from "../lib/error-middleware.js";

/**
 * Build a minimal Express app that mounts request-id middleware,
 * a sample route, and the error middleware + error handler.
 */
function buildTestApp() {
  const app = express();

  // Request ID middleware (mirrors server.js Phase 34)
  app.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });

  // A working route
  app.get("/api/ok", (req, res) => {
    res.json({ status: "ok" });
  });

  // A route that throws with a specific status
  app.get("/api/fail", (req, res, next) => {
    const err = new Error("Intentional failure");
    err.status = 503;
    err.code = "SERVICE_UNAVAILABLE";
    next(err);
  });

  // A route that throws a generic error
  app.get("/api/crash", (req, res, next) => {
    next(new Error("Unexpected crash"));
  });

  // Error middleware (404 for unmatched routes, then error handler)
  app.use(errorMiddleware);
  app.use(errorHandler);

  return app;
}

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

test("404 handler: unmatched route returns 404 with NOT_FOUND code", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/api/this-route-does-not-exist");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
  assert.ok(res.body.error);
});

test("404 handler: unmatched nested route returns 404", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/api/v1/nonexistent/deeply/nested");
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

test("404 handler: includes hint about API docs", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/nope");
  assert.equal(res.status, 404);
  assert.ok(res.body.hint);
  assert.match(res.body.hint, /docs/i);
});

// ---------------------------------------------------------------------------
// Error handler: requestId
// ---------------------------------------------------------------------------

test("error handler: responses include X-Request-Id header", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/api/ok");
  assert.ok(res.headers["x-request-id"], "response should include X-Request-Id header");
  assert.ok(res.headers["x-request-id"].length > 0);
});

test("error handler: 404 response includes X-Request-Id", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/api/nonexistent");
  assert.equal(res.status, 404);
  assert.ok(res.headers["x-request-id"]);
});

test("error handler: honors client-provided X-Request-Id", async () => {
  const app = buildTestApp();
  const customId = "test-req-" + Date.now();
  const res = await request(app)
    .get("/api/ok")
    .set("X-Request-Id", customId);
  assert.equal(res.headers["x-request-id"], customId);
});

// ---------------------------------------------------------------------------
// Error handler: thrown errors with status codes
// ---------------------------------------------------------------------------

test("error handler: returns custom status and requestId for thrown error", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/api/fail");
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "Intentional failure");
  assert.equal(res.body.code, "SERVICE_UNAVAILABLE");
  assert.ok(res.body.requestId);
});

test("error handler: generic error defaults to 500", async () => {
  const app = buildTestApp();
  const res = await request(app).get("/api/crash");
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "Unexpected crash");
  assert.equal(res.body.code, "INTERNAL_ERROR");
  assert.ok(res.body.requestId);
});

// ---------------------------------------------------------------------------
// Error handler unit tests (direct middleware invocation)
// ---------------------------------------------------------------------------

test("errorHandler: returns error status and requestId in JSON body", async () => {
  const { errorHandler } = await import("../lib/error-middleware.js");

  const req = {
    method: "GET",
    path: "/test",
    requestId: "req-abc-123",
    headers: {},
  };
  const res = {
    _status: null,
    _body: null,
    headersSent: false,
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._body = body;
      return res;
    },
  };
  const err = new Error("Something broke");
  err.status = 502;

  errorHandler(err, req, res, () => {});

  assert.equal(res._status, 502);
  assert.equal(res._body.requestId, "req-abc-123");
  assert.equal(res._body.error, "Something broke");
});

test("errorHandler: defaults to 500 when error has no status", async () => {
  const { errorHandler } = await import("../lib/error-middleware.js");

  const req = { method: "POST", path: "/crash", requestId: "req-xyz", headers: {} };
  const res = {
    _status: null,
    _body: null,
    headersSent: false,
    status(code) { res._status = code; return res; },
    json(body) { res._body = body; return res; },
  };

  errorHandler(new Error("unhandled"), req, res, () => {});

  assert.equal(res._status, 500);
  assert.equal(res._body.code, "INTERNAL_ERROR");
  assert.equal(res._body.requestId, "req-xyz");
});

test("errorHandler: respects err.statusCode when status not set", async () => {
  const { errorHandler } = await import("../lib/error-middleware.js");

  const req = { method: "GET", path: "/test", requestId: "req-456", headers: {} };
  const res = {
    _status: null,
    _body: null,
    headersSent: false,
    status(code) { res._status = code; return res; },
    json(body) { res._body = body; return res; },
  };
  const err = new Error("Bad gateway");
  err.statusCode = 503;

  errorHandler(err, req, res, () => {});

  assert.equal(res._status, 503);
});

test("errorHandler: calls next when headers already sent", async () => {
  const { errorHandler } = await import("../lib/error-middleware.js");

  const req = { method: "GET", path: "/test", requestId: "req-789", headers: {} };
  const res = { headersSent: true };
  let nextCalledWith = null;
  const err = new Error("late error");

  errorHandler(err, req, res, (e) => { nextCalledWith = e; });

  assert.equal(nextCalledWith, err, "should delegate to next when headers already sent");
});

test("errorHandler: falls back to x-request-id header when req.requestId missing", async () => {
  const { errorHandler } = await import("../lib/error-middleware.js");

  const req = { method: "GET", path: "/test", headers: { "x-request-id": "header-id-999" } };
  const res = {
    _status: null,
    _body: null,
    headersSent: false,
    status(code) { res._status = code; return res; },
    json(body) { res._body = body; return res; },
  };

  errorHandler(new Error("oops"), req, res, () => {});

  assert.equal(res._body.requestId, "header-id-999");
});
