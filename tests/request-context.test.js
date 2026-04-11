import test from "node:test";
import assert from "node:assert/strict";
import {
  getRequestContext,
  getRequestId,
  withRequestContext,
  requestContextMiddleware,
} from "../lib/request-context.js";

test("getRequestId returns 'unknown' when no context is active", () => {
  assert.equal(getRequestId(), "unknown");
});

test("getRequestContext returns empty object when no context is active", () => {
  const ctx = getRequestContext();
  assert.deepStrictEqual(ctx, {});
});

test("withRequestContext propagates requestId through sync code", () => {
  const result = withRequestContext({ requestId: "req-123" }, () => {
    return getRequestId();
  });
  assert.equal(result, "req-123");
});

test("withRequestContext propagates full context", () => {
  const context = { requestId: "req-456", userId: "user-1", workspace: "ws-1", startTime: 1000 };
  withRequestContext(context, () => {
    const ctx = getRequestContext();
    assert.equal(ctx.requestId, "req-456");
    assert.equal(ctx.userId, "user-1");
    assert.equal(ctx.workspace, "ws-1");
    assert.equal(ctx.startTime, 1000);
  });
});

test("withRequestContext propagates through async calls", async () => {
  const result = await withRequestContext({ requestId: "async-789" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return getRequestId();
  });
  assert.equal(result, "async-789");
});

test("withRequestContext propagates through nested async calls", async () => {
  const ids = [];
  await withRequestContext({ requestId: "outer-1" }, async () => {
    ids.push(getRequestId());
    await new Promise((r) => setTimeout(r, 5));
    ids.push(getRequestId());
  });
  assert.deepStrictEqual(ids, ["outer-1", "outer-1"]);
});

test("nested contexts are isolated", async () => {
  const results = [];

  await withRequestContext({ requestId: "outer" }, async () => {
    results.push(["before-inner", getRequestId()]);

    await withRequestContext({ requestId: "inner" }, async () => {
      results.push(["inner", getRequestId()]);
      await new Promise((r) => setTimeout(r, 5));
      results.push(["inner-after-await", getRequestId()]);
    });

    results.push(["after-inner", getRequestId()]);
  });

  assert.deepStrictEqual(results, [
    ["before-inner", "outer"],
    ["inner", "inner"],
    ["inner-after-await", "inner"],
    ["after-inner", "outer"],
  ]);
});

test("concurrent contexts do not interfere", async () => {
  const results = [];

  const p1 = withRequestContext({ requestId: "ctx-a" }, async () => {
    await new Promise((r) => setTimeout(r, 10));
    results.push(["a", getRequestId()]);
  });

  const p2 = withRequestContext({ requestId: "ctx-b" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    results.push(["b", getRequestId()]);
  });

  await Promise.all([p1, p2]);

  const a = results.find((r) => r[0] === "a");
  const b = results.find((r) => r[0] === "b");
  assert.equal(a[1], "ctx-a");
  assert.equal(b[1], "ctx-b");
});

test("requestContextMiddleware sets context from req", (t, done) => {
  const middleware = requestContextMiddleware();

  const req = {
    requestId: "mw-req-001",
    userId: "user-42",
    query: { workspace: "test-ws" },
  };
  const res = {};

  middleware(req, res, () => {
    const ctx = getRequestContext();
    assert.equal(ctx.requestId, "mw-req-001");
    assert.equal(ctx.userId, "user-42");
    assert.equal(ctx.workspace, "test-ws");
    assert.equal(typeof ctx.startTime, "number");
    assert.ok(ctx.startTime <= Date.now());
    done();
  });
});

test("requestContextMiddleware defaults workspace to 'default'", (t, done) => {
  const middleware = requestContextMiddleware();

  const req = { requestId: "mw-req-002", query: {} };
  const res = {};

  middleware(req, res, () => {
    const ctx = getRequestContext();
    assert.equal(ctx.workspace, "default");
    done();
  });
});

test("requestContextMiddleware handles missing query", (t, done) => {
  const middleware = requestContextMiddleware();

  const req = { requestId: "mw-req-003" };
  const res = {};

  middleware(req, res, () => {
    const ctx = getRequestContext();
    assert.equal(ctx.requestId, "mw-req-003");
    assert.equal(ctx.workspace, "default");
    done();
  });
});

test("context is not available after withRequestContext returns", () => {
  withRequestContext({ requestId: "temp" }, () => {
    assert.equal(getRequestId(), "temp");
  });
  assert.equal(getRequestId(), "unknown");
});
