/**
 * Tests for lib/request-timeout.js and lib/response-helpers.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { requestTimeout, streamingTimeout } from "../lib/request-timeout.js";
import { paginated, success, created } from "../lib/response-helpers.js";

// --- Helper: mock req/res ---

function mockReq(overrides = {}) {
  return { requestId: "test-req-id", ...overrides };
}

function mockRes() {
  const listeners = {};
  const res = {
    headersSent: false,
    statusCode: null,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      res.headersSent = true;
      // Fire finish listeners
      (listeners["finish"] || []).forEach((fn) => fn());
      return res;
    },
    on(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
      return res;
    },
    _emit(event) {
      (listeners[event] || []).forEach((fn) => fn());
    },
  };
  return res;
}

// --- requestTimeout ---

test("requestTimeout: request under timeout succeeds normally", async () => {
  const middleware = requestTimeout(200);
  const req = mockReq();
  const res = mockRes();

  await new Promise((resolve) => {
    middleware(req, res, () => {
      // Simulate fast handler completing
      res.status(200).json({ ok: true });
      resolve();
    });
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("requestTimeout: slow handler gets 504 after timeout", async () => {
  const middleware = requestTimeout(50);
  const req = mockReq();
  const res = mockRes();

  await new Promise((resolve) => {
    middleware(req, res, () => {
      // Simulate slow handler - do not respond
      setTimeout(() => {
        resolve();
      }, 100);
    });
  });

  assert.equal(res.statusCode, 504);
  assert.equal(res.body.code, "TIMEOUT");
  assert.equal(res.body.error, "Request timeout");
  assert.ok(res.body.hint.includes("50ms"));
  assert.equal(res.body.requestId, "test-req-id");
});

test("requestTimeout: does not send 504 if headers already sent", async () => {
  const middleware = requestTimeout(50);
  const req = mockReq();
  const res = mockRes();

  await new Promise((resolve) => {
    middleware(req, res, () => {
      // Mark headers as already sent (e.g. streaming started)
      res.headersSent = true;
      setTimeout(() => {
        // After timeout fires, statusCode should not change
        resolve();
      }, 100);
    });
  });

  // statusCode should be null since we never called status()
  assert.equal(res.statusCode, null);
});

test("requestTimeout: cleanup on normal response (timer cleared)", async () => {
  const middleware = requestTimeout(100);
  const req = mockReq();
  const res = mockRes();

  await new Promise((resolve) => {
    middleware(req, res, () => {
      // Respond immediately - this triggers finish which clears the timer
      res.status(200).json({ done: true });
    });

    // Wait past the timeout to verify no 504
    setTimeout(() => {
      resolve();
    }, 150);
  });

  // Should still be 200, not overwritten to 504
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { done: true });
});

test("requestTimeout: cleanup on close event", async () => {
  const middleware = requestTimeout(100);
  const req = mockReq();
  const res = mockRes();

  await new Promise((resolve) => {
    middleware(req, res, () => {
      // Simulate client disconnect (close event)
      res._emit("close");
    });

    setTimeout(() => {
      resolve();
    }, 150);
  });

  // Timer was cleared on close, so no 504 should have been sent
  assert.equal(res.statusCode, null);
});

test("streamingTimeout: returns middleware with longer timeout", () => {
  const middleware = streamingTimeout();
  assert.equal(typeof middleware, "function");
  assert.equal(middleware.length, 3); // (req, res, next)
});

test("requestTimeout: default timeout used when no argument", () => {
  const middleware = requestTimeout();
  assert.equal(typeof middleware, "function");
});

// --- response-helpers: paginated ---

test("paginated: returns items with default options", () => {
  const res = mockRes();
  paginated(res, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(res.body, {
    items: [{ id: 1 }, { id: 2 }],
    cursor: null,
    hasMore: false,
  });
});

test("paginated: returns cursor, hasMore, and total when provided", () => {
  const res = mockRes();
  paginated(res, [{ id: 1 }], { cursor: "abc", hasMore: true, total: 42 });
  assert.deepEqual(res.body, {
    items: [{ id: 1 }],
    cursor: "abc",
    hasMore: true,
    total: 42,
  });
});

test("paginated: omits total when not provided", () => {
  const res = mockRes();
  paginated(res, [], { cursor: null, hasMore: false });
  assert.ok(!("total" in res.body));
});

// --- response-helpers: success ---

test("success: returns data with 200 by default", () => {
  const res = mockRes();
  success(res, { result: "ok" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { result: "ok" });
});

test("success: returns data with custom status", () => {
  const res = mockRes();
  success(res, { accepted: true }, 202);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.body, { accepted: true });
});

// --- response-helpers: created ---

test("created: returns data with 201", () => {
  const res = mockRes();
  created(res, { id: "new-thing" });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { id: "new-thing" });
});
