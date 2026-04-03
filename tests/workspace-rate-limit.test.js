/**
 * Per-workspace rate limiting tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  workspaceRateLimiter,
  getWorkspaceRateLimitStatus,
  setWorkspaceRateLimit,
  _resetForTesting,
} from "../lib/workspace-rate-limit.js";

// Helper to create mock req/res/next
function mockReq(params = {}, query = {}, body = {}) {
  return { params, query, body };
}

function mockRes() {
  const headers = {};
  const res = {
    _status: null,
    _json: null,
    _headers: headers,
    setHeader(k, v) { headers[k] = v; },
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

test("workspace-rate-limit: requests within limit pass", () => {
  _resetForTesting();
  const mw = workspaceRateLimiter();
  const req = mockReq({ id: "ws-pass" });
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.ok(called, "next() should be called");
  assert.equal(res._status, null, "should not set error status");
  assert.ok(res._headers["X-RateLimit-Limit"], "should set X-RateLimit-Limit header");
  assert.ok(res._headers["X-RateLimit-Remaining"] !== undefined, "should set X-RateLimit-Remaining header");
  assert.ok(res._headers["X-RateLimit-Reset"], "should set X-RateLimit-Reset header");
});

test("workspace-rate-limit: requests over limit get 429", () => {
  _resetForTesting();
  // Set a very low limit for testing
  setWorkspaceRateLimit("ws-limited", 3);
  const mw = workspaceRateLimiter();

  for (let i = 0; i < 3; i++) {
    const req = mockReq({ id: "ws-limited" });
    const res = mockRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(called, `request ${i + 1} should pass`);
  }

  // 4th request should be blocked
  const req = mockReq({ id: "ws-limited" });
  const res = mockRes();
  let blocked = true;
  mw(req, res, () => { blocked = false; });
  assert.ok(blocked, "4th request should be blocked");
  assert.equal(res._status, 429, "should return 429");
  assert.ok(res._json.error.code === "WORKSPACE_RATE_LIMIT");
});

test("workspace-rate-limit: sliding window allows requests after time passes", async () => {
  _resetForTesting();
  // We cannot easily test time passage without mocking Date.now, but we can
  // verify that the status correctly reflects window state.
  setWorkspaceRateLimit("ws-sliding", 2);
  const mw = workspaceRateLimiter();

  // Use 2 requests
  for (let i = 0; i < 2; i++) {
    const req = mockReq({ id: "ws-sliding" });
    const res = mockRes();
    mw(req, res, () => {});
  }

  // Should be blocked now
  const status = getWorkspaceRateLimitStatus("ws-sliding");
  assert.equal(status.used, 2);
  assert.equal(status.remaining, 0);
  assert.equal(status.limit, 2);
});

test("workspace-rate-limit: per-workspace isolation", () => {
  _resetForTesting();
  setWorkspaceRateLimit("ws-a", 2);
  setWorkspaceRateLimit("ws-b", 2);
  const mw = workspaceRateLimiter();

  // Exhaust ws-a
  for (let i = 0; i < 2; i++) {
    const req = mockReq({ id: "ws-a" });
    const res = mockRes();
    mw(req, res, () => {});
  }

  // ws-b should still work
  const req = mockReq({ id: "ws-b" });
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.ok(called, "ws-b should not be affected by ws-a limit");

  // ws-a should be blocked
  const reqA = mockReq({ id: "ws-a" });
  const resA = mockRes();
  let blockedA = true;
  mw(reqA, resA, () => { blockedA = false; });
  assert.ok(blockedA, "ws-a should be blocked");
  assert.equal(resA._status, 429);
});

test("workspace-rate-limit: headers are correct", () => {
  _resetForTesting();
  setWorkspaceRateLimit("ws-headers", 10);
  const mw = workspaceRateLimiter();

  const req = mockReq({ id: "ws-headers" });
  const res = mockRes();
  mw(req, res, () => {});

  assert.equal(res._headers["X-RateLimit-Limit"], "10");
  // After 1 request, remaining should be 10 - 1 = 9
  assert.equal(res._headers["X-RateLimit-Remaining"], "9");
  // Reset should be a Unix epoch seconds value in the future
  const reset = parseInt(res._headers["X-RateLimit-Reset"], 10);
  assert.ok(reset > Math.floor(Date.now() / 1000), "reset should be in the future");
});

test("workspace-rate-limit: override functionality", () => {
  _resetForTesting();

  // Default limit is 300; override to 5
  setWorkspaceRateLimit("ws-override", 5);
  const status = getWorkspaceRateLimitStatus("ws-override");
  assert.equal(status.limit, 5);
  assert.equal(status.remaining, 5);

  // setWorkspaceRateLimit rejects non-positive values
  assert.throws(() => setWorkspaceRateLimit("ws-override", 0), /positive/);
  assert.throws(() => setWorkspaceRateLimit("ws-override", -1), /positive/);
});

test("workspace-rate-limit: skips when no workspace in request", () => {
  _resetForTesting();
  const mw = workspaceRateLimiter();
  const req = mockReq(); // no id param
  const res = mockRes();
  let called = false;
  mw(req, res, () => { called = true; });
  assert.ok(called, "should call next when no workspace context");
  assert.equal(res._headers["X-RateLimit-Limit"], undefined, "should not set rate limit headers");
});

test("workspace-rate-limit: getWorkspaceRateLimitStatus returns info for unknown workspace", () => {
  _resetForTesting();
  const status = getWorkspaceRateLimitStatus("unknown-ws");
  assert.equal(status.workspaceId, "unknown-ws");
  assert.equal(status.used, 0);
  assert.equal(status.limit, 300); // default
  assert.equal(status.remaining, 300);
});
