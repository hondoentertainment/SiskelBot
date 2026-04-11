/**
 * Phase 36.1: Tests for lib/service-tokens.js — issue, verify, exchange, expiry, replay.
 */
import test from "node:test";
import assert from "node:assert/strict";

const ORIG_SECRET = process.env.SERVICE_TOKEN_SECRET;
process.env.SERVICE_TOKEN_SECRET = "test-service-token-secret-please-ignore-me";

const {
  issueServiceToken,
  verifyServiceToken,
  exchangeUserTokenForServiceToken,
  serviceTokenMiddleware,
  consumeNonce,
  _resetSeenNoncesForTesting,
} = await import("../lib/service-tokens.js");

test.after(() => {
  if (ORIG_SECRET === undefined) delete process.env.SERVICE_TOKEN_SECRET;
  else process.env.SERVICE_TOKEN_SECRET = ORIG_SECRET;
});

function buildRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
}

// ── issueServiceToken ───────────────────────────────────────────────────────

test("issueServiceToken: requires serviceId", () => {
  assert.throws(() => issueServiceToken("", ["read"], 60), /serviceId is required/);
});

test("issueServiceToken: requires scopes array", () => {
  assert.throws(() => issueServiceToken("svc-a", "read", 60), /scopes must be an array/);
});

test("issueServiceToken: produces a three-part token", () => {
  const { token, payload } = issueServiceToken("svc-a", ["read", "write"], 60);
  assert.equal(typeof token, "string");
  assert.equal(token.split(".").length, 3);
  assert.equal(payload.sub, "svc-a");
  assert.deepEqual(payload.scopes, ["read", "write"]);
  assert.ok(payload.nonce);
  assert.ok(payload.iat);
  assert.ok(payload.exp > payload.iat);
});

test("issueServiceToken: throws when SERVICE_TOKEN_SECRET is missing/short", async () => {
  const orig = process.env.SERVICE_TOKEN_SECRET;
  process.env.SERVICE_TOKEN_SECRET = "short";
  try {
    assert.throws(() => issueServiceToken("svc-a", ["read"], 60), /SERVICE_TOKEN_SECRET/);
  } finally {
    process.env.SERVICE_TOKEN_SECRET = orig;
  }
});

test("issueServiceToken: clamps ttlSeconds to ceiling", () => {
  const { payload } = issueServiceToken("svc-a", ["read"], 999999);
  const ttl = payload.exp - payload.iat;
  assert.ok(ttl <= 3600, `ttl should be <= 3600, got ${ttl}`);
});

// ── verifyServiceToken ──────────────────────────────────────────────────────

test("verifyServiceToken: valid roundtrip", () => {
  const { token } = issueServiceToken("svc-roundtrip", ["read", "admin"], 60);
  const result = verifyServiceToken(token);
  assert.equal(result.valid, true);
  assert.equal(result.serviceId, "svc-roundtrip");
  assert.deepEqual(result.scopes, ["read", "admin"]);
});

test("verifyServiceToken: rejects empty/missing token", () => {
  assert.equal(verifyServiceToken("").valid, false);
  assert.equal(verifyServiceToken(null).valid, false);
  assert.equal(verifyServiceToken(undefined).valid, false);
});

test("verifyServiceToken: rejects malformed token", () => {
  const result = verifyServiceToken("not.a-valid-token");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "malformed");
});

test("verifyServiceToken: rejects tampered signature", () => {
  const { token } = issueServiceToken("svc-a", ["read"], 60);
  const parts = token.split(".");
  const tampered = `${parts[0]}.${parts[1]}.AAAA${parts[2].slice(4)}`;
  const result = verifyServiceToken(tampered);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "bad_signature");
});

test("verifyServiceToken: rejects tampered payload (signature mismatch)", () => {
  const { token } = issueServiceToken("svc-a", ["read"], 60);
  const parts = token.split(".");
  // Re-encode payload with different scopes
  const forgedPayload = Buffer.from(
    JSON.stringify({ sub: "attacker", scopes: ["admin"], iat: 1, exp: 9_999_999_999, nonce: "x" })
  )
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
  const result = verifyServiceToken(forged);
  assert.equal(result.valid, false);
});

test("verifyServiceToken: rejects expired token", () => {
  // Build token with a past expiry by mocking Date.now briefly.
  const realNow = Date.now;
  Date.now = () => realNow() - 1000 * 60 * 60 * 24;
  let token;
  try {
    token = issueServiceToken("svc-old", ["read"], 10).token;
  } finally {
    Date.now = realNow;
  }
  const result = verifyServiceToken(token);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "expired");
});

test("verifyServiceToken: rejects token with iat too far in future", () => {
  const realNow = Date.now;
  Date.now = () => realNow() + 1000 * 60 * 60;
  let token;
  try {
    token = issueServiceToken("svc-future", ["read"], 60).token;
  } finally {
    Date.now = realNow;
  }
  const result = verifyServiceToken(token);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "iat_in_future");
});

// ── exchangeUserTokenForServiceToken ────────────────────────────────────────

test("exchangeUserTokenForServiceToken: requires targetService", () => {
  assert.throws(
    () => exchangeUserTokenForServiceToken({ userId: "u1" }, ""),
    /targetService is required/
  );
});

test("exchangeUserTokenForServiceToken: requires userId", () => {
  assert.throws(
    () => exchangeUserTokenForServiceToken({}, "svc-b"),
    /did not yield a userId/
  );
});

test("exchangeUserTokenForServiceToken: mints short-lived token with audience", () => {
  const { token, payload } = exchangeUserTokenForServiceToken(
    { userId: "alice", scopes: ["read", "write"] },
    "svc-payments",
    60
  );
  assert.equal(payload.sub, "user:alice");
  assert.equal(payload.aud, "svc-payments");
  assert.equal(payload.on_behalf_of, "alice");
  assert.deepEqual(payload.scopes, ["read", "write"]);

  const verified = verifyServiceToken(token);
  assert.equal(verified.valid, true);
  assert.equal(verified.payload.aud, "svc-payments");
});

test("exchangeUserTokenForServiceToken: accepts raw user id string", () => {
  const { payload } = exchangeUserTokenForServiceToken("bob", "svc-b");
  assert.equal(payload.sub, "user:bob");
  assert.deepEqual(payload.scopes, ["read"]);
});

test("exchangeUserTokenForServiceToken: caps exchange ttl at 600s", () => {
  const { payload } = exchangeUserTokenForServiceToken({ userId: "alice" }, "svc-b", 99999);
  const ttl = payload.exp - payload.iat;
  assert.ok(ttl <= 600, `ttl should be <= 600, got ${ttl}`);
});

// ── consumeNonce (replay protection) ────────────────────────────────────────

test("consumeNonce: accepts first use, rejects second use", () => {
  _resetSeenNoncesForTesting();
  assert.equal(consumeNonce("nonce-123"), true);
  assert.equal(consumeNonce("nonce-123"), false);
});

test("consumeNonce: different nonces both accepted", () => {
  _resetSeenNoncesForTesting();
  assert.equal(consumeNonce("n-a"), true);
  assert.equal(consumeNonce("n-b"), true);
});

test("consumeNonce: rejects empty nonce", () => {
  _resetSeenNoncesForTesting();
  assert.equal(consumeNonce(""), false);
  assert.equal(consumeNonce(null), false);
});

// ── serviceTokenMiddleware ──────────────────────────────────────────────────

test("serviceTokenMiddleware: 401 when token is missing", () => {
  const mw = serviceTokenMiddleware("read");
  const req = { headers: {} };
  const res = buildRes();
  let called = false;
  mw(req, res, () => {
    called = true;
  });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "SERVICE_TOKEN_REQUIRED");
});

test("serviceTokenMiddleware: 401 when token is invalid", () => {
  const mw = serviceTokenMiddleware("read");
  const req = { headers: { authorization: "Bearer totally.invalid.garbage" } };
  const res = buildRes();
  mw(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.code, "SERVICE_TOKEN_INVALID");
});

test("serviceTokenMiddleware: 403 when required scope is missing", () => {
  const { token } = issueServiceToken("svc-a", ["read"], 60);
  const mw = serviceTokenMiddleware("admin");
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = buildRes();
  mw(req, res, () => {});
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "SERVICE_TOKEN_SCOPE");
});

test("serviceTokenMiddleware: passes and attaches req.serviceToken on success", () => {
  const { token } = issueServiceToken("svc-a", ["read", "admin"], 60);
  const mw = serviceTokenMiddleware("admin");
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = buildRes();
  let called = false;
  mw(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(res.statusCode, null);
  assert.equal(req.serviceToken.serviceId, "svc-a");
  assert.deepEqual(req.serviceToken.scopes, ["read", "admin"]);
});

test("serviceTokenMiddleware: accepts x-service-token header fallback", () => {
  const { token } = issueServiceToken("svc-b", ["read"], 60);
  const mw = serviceTokenMiddleware("read");
  const req = { headers: { "x-service-token": token } };
  const res = buildRes();
  let called = false;
  mw(req, res, () => {
    called = true;
  });
  assert.equal(called, true);
});

test("serviceTokenMiddleware: enforces replay protection with checkReplay=true", () => {
  _resetSeenNoncesForTesting();
  const { token } = issueServiceToken("svc-c", ["read"], 60);
  const mw = serviceTokenMiddleware("read", { checkReplay: true });

  // First use passes
  const req1 = { headers: { authorization: `Bearer ${token}` } };
  const res1 = buildRes();
  let called1 = false;
  mw(req1, res1, () => {
    called1 = true;
  });
  assert.equal(called1, true);

  // Second use rejected
  const req2 = { headers: { authorization: `Bearer ${token}` } };
  const res2 = buildRes();
  mw(req2, res2, () => {});
  assert.equal(res2.statusCode, 401);
  assert.equal(res2.body.code, "SERVICE_TOKEN_REPLAY");
});
