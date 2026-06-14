import test from "node:test";
import assert from "node:assert/strict";
import { requireScope } from "../lib/scope-middleware.js";

function mockReq(overrides = {}) {
  return { session: {}, apiKeyScopes: undefined, ...overrides };
}

function mockRes() {
  let statusCode = 200;
  let body = null;
  return {
    status(code) { statusCode = code; return this; },
    json(data) { body = data; return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

test("requireScope allows session users without scopes", () => {
  const middleware = requireScope("chat:write");
  const req = mockReq({ session: { userId: "user1" } });
  const res = mockRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("requireScope allows when no scopes are set (anonymous/legacy)", () => {
  const middleware = requireScope("chat:write");
  const req = mockReq();
  const res = mockRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("requireScope allows when scope is present in apiKeyScopes", () => {
  const middleware = requireScope("chat:write");
  const req = mockReq({ apiKeyScopes: ["chat:write", "chat:read"] });
  const res = mockRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("requireScope denies when scope is missing from apiKeyScopes", () => {
  const middleware = requireScope("admin:write");
  const req = mockReq({ apiKeyScopes: ["chat:read"] });
  const res = mockRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(!called);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "SCOPE_REQUIRED");
  assert.ok(res.body.hint.includes("admin:write"));
});

test("requireScope allows when required scope is empty string", () => {
  const middleware = requireScope("");
  const req = mockReq({ apiKeyScopes: ["chat:read"] });
  const res = mockRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("requireScope is case-insensitive for required scope", () => {
  const middleware = requireScope("Chat:Write");
  const req = mockReq({ apiKeyScopes: ["chat:write"] });
  const res = mockRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});

test("requireScope skips scope check for session users even with apiKeyScopes absent", () => {
  const middleware = requireScope("admin:write");
  const req = mockReq({ session: { userId: "admin1" }, apiKeyScopes: undefined });
  const res = mockRes();
  let called = false;
  middleware(req, res, () => { called = true; });
  assert.ok(called);
});
