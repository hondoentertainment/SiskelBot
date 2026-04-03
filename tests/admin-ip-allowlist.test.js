/**
 * Admin IP allowlist middleware tests.
 * Tests lib/admin-ip-allowlist.js directly using mock Express req/res objects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { adminIpAllowlist } from "../lib/admin-ip-allowlist.js";

/**
 * Create a minimal mock req with the given IP.
 */
function mockReq(ip) {
  return { ip, socket: { remoteAddress: ip } };
}

/**
 * Create a minimal mock res that captures status and JSON body.
 */
function mockRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) {
      res._status = code;
      return res;
    },
    json(body) {
      res._body = body;
      return res;
    },
  };
  return res;
}

test.afterEach(() => {
  delete process.env.ADMIN_IP_ALLOWLIST;
});

// ---------------------------------------------------------------------------
// No allowlist configured
// ---------------------------------------------------------------------------

test("no ADMIN_IP_ALLOWLIST: middleware passes through", () => {
  delete process.env.ADMIN_IP_ALLOWLIST;
  const req = mockReq("192.168.1.100");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, "next() should be called when no allowlist is set");
  assert.equal(res._status, null, "should not set a status code");
});

test("empty ADMIN_IP_ALLOWLIST: middleware passes through", () => {
  process.env.ADMIN_IP_ALLOWLIST = "  ,  , ";
  const req = mockReq("10.0.0.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
});

// ---------------------------------------------------------------------------
// Exact IP match
// ---------------------------------------------------------------------------

test("exact IP match: allows request", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.0.0.5,192.168.1.1";
  const req = mockReq("192.168.1.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, "should allow matching IP");
});

test("exact IP no match: returns 403", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.0.0.5,192.168.1.1";
  const req = mockReq("172.16.0.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, "next() should not be called for blocked IP");
  assert.equal(res._status, 403);
  assert.equal(res._body.code, "IP_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// CIDR /24 matching
// ---------------------------------------------------------------------------

test("CIDR /24: allows IP in same /24 subnet", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.20.30.0/24";
  const req = mockReq("10.20.30.99");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, "IP in /24 range should be allowed");
});

test("CIDR /24: blocks IP outside /24 subnet", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.20.30.0/24";
  const req = mockReq("10.20.31.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 403);
});

// ---------------------------------------------------------------------------
// CIDR /16 matching
// ---------------------------------------------------------------------------

test("CIDR /16: allows IP in same /16 subnet", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.20.0.0/16";
  const req = mockReq("10.20.255.123");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, "IP in /16 range should be allowed");
});

test("CIDR /16: blocks IP outside /16 subnet", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.20.0.0/16";
  const req = mockReq("10.21.0.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 403);
});

// ---------------------------------------------------------------------------
// IPv6-mapped addresses
// ---------------------------------------------------------------------------

test("IPv6-mapped address: ::ffff:127.0.0.1 matches 127.0.0.1", () => {
  process.env.ADMIN_IP_ALLOWLIST = "127.0.0.1";
  const req = mockReq("::ffff:127.0.0.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, "IPv6-mapped 127.0.0.1 should match allowlist entry 127.0.0.1");
});

test("IPv6-mapped address: ::ffff:10.20.30.5 matches CIDR 10.20.30.0/24", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.20.30.0/24";
  const req = mockReq("::ffff:10.20.30.5");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, "IPv6-mapped address should match /24 CIDR");
});

test("IPv6-mapped address: blocked when not in allowlist", () => {
  process.env.ADMIN_IP_ALLOWLIST = "192.168.1.0/24";
  const req = mockReq("::ffff:10.0.0.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 403);
});

// ---------------------------------------------------------------------------
// Multiple entries
// ---------------------------------------------------------------------------

test("multiple entries: allows if any entry matches", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.0.0.1, 192.168.0.0/16, 172.16.5.5";
  const req = mockReq("192.168.99.42");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
});

test("multiple entries: blocks if no entry matches", () => {
  process.env.ADMIN_IP_ALLOWLIST = "10.0.0.1, 192.168.0.0/24";
  const req = mockReq("172.16.0.1");
  const res = mockRes();
  let nextCalled = false;
  adminIpAllowlist(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res._status, 403);
  assert.ok(res._body.hint.includes("ADMIN_IP_ALLOWLIST"));
});
