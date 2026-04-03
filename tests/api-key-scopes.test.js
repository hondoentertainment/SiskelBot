import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseApiKey, hasScope, requireScope, ALL_SCOPES } from "../lib/api-key-scopes.js";

describe("parseApiKey", () => {
  it("returns null for empty/invalid input", () => {
    assert.equal(parseApiKey(null), null);
    assert.equal(parseApiKey(undefined), null);
    assert.equal(parseApiKey(""), null);
    assert.equal(parseApiKey("   "), null);
    assert.equal(parseApiKey(123), null);
  });

  it("parses key-only format (legacy) with all scopes", () => {
    const result = parseApiKey("mykey123");
    assert.equal(result.key, "mykey123");
    assert.equal(result.userId, null);
    assert.deepEqual(result.scopes, ALL_SCOPES);
  });

  it("parses key:userId format (legacy) with all scopes", () => {
    const result = parseApiKey("mykey123:user1");
    assert.equal(result.key, "mykey123");
    assert.equal(result.userId, "user1");
    assert.deepEqual(result.scopes, ALL_SCOPES);
  });

  it("parses key:userId:scopes format with specific scopes", () => {
    const result = parseApiKey("mykey123:user1:read,write");
    assert.equal(result.key, "mykey123");
    assert.equal(result.userId, "user1");
    assert.deepEqual(result.scopes, ["read", "write"]);
  });

  it("parses single scope", () => {
    const result = parseApiKey("k:u:read");
    assert.deepEqual(result.scopes, ["read"]);
  });

  it("parses all four scopes", () => {
    const result = parseApiKey("k:u:read,write,admin,embed");
    assert.deepEqual(result.scopes, ["read", "write", "admin", "embed"]);
  });

  it("filters out invalid scopes", () => {
    const result = parseApiKey("k:u:read,invalid,write");
    assert.deepEqual(result.scopes, ["read", "write"]);
  });

  it("defaults to all scopes when all specified scopes are invalid", () => {
    const result = parseApiKey("k:u:bogus,nope");
    assert.deepEqual(result.scopes, ALL_SCOPES);
  });

  it("handles whitespace in scopes", () => {
    const result = parseApiKey("k : u : read , write ");
    assert.equal(result.key, "k");
    assert.equal(result.userId, "u");
    assert.deepEqual(result.scopes, ["read", "write"]);
  });

  it("normalizes scope case", () => {
    const result = parseApiKey("k:u:READ,Write,ADMIN");
    assert.deepEqual(result.scopes, ["read", "write", "admin"]);
  });
});

describe("hasScope", () => {
  it("returns true when key has the required scope", () => {
    const parsed = { scopes: ["read", "write"] };
    assert.equal(hasScope(parsed, "read"), true);
    assert.equal(hasScope(parsed, "write"), true);
  });

  it("returns false when key lacks the required scope", () => {
    const parsed = { scopes: ["read"] };
    assert.equal(hasScope(parsed, "write"), false);
    assert.equal(hasScope(parsed, "admin"), false);
  });

  it("returns false for null/invalid input", () => {
    assert.equal(hasScope(null, "read"), false);
    assert.equal(hasScope({}, "read"), false);
    assert.equal(hasScope({ scopes: "read" }, "read"), false);
  });

  it("returns true for all scopes on legacy key", () => {
    const parsed = parseApiKey("legacykey");
    for (const scope of ALL_SCOPES) {
      assert.equal(hasScope(parsed, scope), true, `should have ${scope}`);
    }
  });
});

describe("requireScope middleware", () => {
  function mockReq(scopes) {
    return { apiKeyScopes: scopes };
  }

  function mockRes() {
    let statusCode = null;
    let body = null;
    const res = {
      status(code) { statusCode = code; return res; },
      json(obj) { body = obj; return res; },
      get statusCode() { return statusCode; },
      get body() { return body; },
    };
    return res;
  }

  it("allows request when scope is present", (_, done) => {
    const middleware = requireScope("read");
    const req = mockReq(["read", "write"]);
    const res = mockRes();
    middleware(req, res, () => {
      // next() called — pass
      done();
    });
  });

  it("returns 403 when scope is missing", () => {
    const middleware = requireScope("admin");
    const req = mockReq(["read", "write"]);
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "SCOPE_INSUFFICIENT");
    assert.equal(res.body.requiredScope, "admin");
  });

  it("allows request when no apiKeyScopes set (session/anonymous auth)", (_, done) => {
    const middleware = requireScope("write");
    const req = {}; // no apiKeyScopes
    const res = mockRes();
    middleware(req, res, () => {
      done();
    });
  });

  it("returns 403 for empty scopes array", () => {
    const middleware = requireScope("read");
    const req = mockReq([]);
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("backward compat: legacy key (all scopes) passes any scope check", (_, done) => {
    const middleware = requireScope("admin");
    const req = mockReq([...ALL_SCOPES]);
    const res = mockRes();
    middleware(req, res, () => {
      done();
    });
  });

  it("embed scope enforced correctly", () => {
    const middleware = requireScope("embed");
    const req = mockReq(["read", "write"]);
    const res = mockRes();
    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /embed/);
  });
});
