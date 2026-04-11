/**
 * Phase 25: Per-workspace IP policy tests.
 * Tests lib/ip-policy.js — policy CRUD, IP checking, CIDR support.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Set test storage path before importing modules
const TEST_DIR = join(process.cwd(), "data", ".test-ip-policy-" + Date.now());
process.env.STORAGE_PATH = TEST_DIR;

import {
  getWorkspaceIpPolicy,
  setWorkspaceIpPolicy,
  checkWorkspaceIpAccess,
} from "../lib/ip-policy.js";

function cleanup() {
  try {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
}

test.before(() => {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
});

test.after(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Policy CRUD
// ---------------------------------------------------------------------------

test("getWorkspaceIpPolicy returns empty policy when none is set", async () => {
  const policy = await getWorkspaceIpPolicy("no-policy-ws");
  assert.deepEqual(policy.allowedIPs, []);
  assert.equal(policy.enabled, false);
});

test("setWorkspaceIpPolicy stores and retrieves a policy", async () => {
  const result = await setWorkspaceIpPolicy("ws-ip-test", ["10.0.0.1", "192.168.1.0/24"]);
  assert.deepEqual(result.allowedIPs, ["10.0.0.1", "192.168.1.0/24"]);
  assert.equal(result.enabled, true);
  assert.ok(result.updatedAt);

  const fetched = await getWorkspaceIpPolicy("ws-ip-test");
  assert.deepEqual(fetched.allowedIPs, ["10.0.0.1", "192.168.1.0/24"]);
  assert.equal(fetched.enabled, true);
});

test("setWorkspaceIpPolicy with empty array disables the policy", async () => {
  await setWorkspaceIpPolicy("ws-ip-disable", ["10.0.0.1"]);
  const result = await setWorkspaceIpPolicy("ws-ip-disable", []);
  assert.deepEqual(result.allowedIPs, []);
  assert.equal(result.enabled, false);
});

test("setWorkspaceIpPolicy rejects invalid IPs", async () => {
  await assert.rejects(
    () => setWorkspaceIpPolicy("ws-invalid-ip", ["not-an-ip"]),
    /Invalid IP/
  );
});

test("setWorkspaceIpPolicy rejects invalid CIDR prefix", async () => {
  await assert.rejects(
    () => setWorkspaceIpPolicy("ws-invalid-cidr", ["10.0.0.0/99"]),
    /Invalid CIDR/
  );
});

test("setWorkspaceIpPolicy rejects non-array allowedIPs", async () => {
  await assert.rejects(
    () => setWorkspaceIpPolicy("ws-bad-type", "10.0.0.1"),
    /must be an array/
  );
});

test("setWorkspaceIpPolicy filters out empty strings", async () => {
  const result = await setWorkspaceIpPolicy("ws-ip-filter", ["10.0.0.1", "", "  ", "192.168.1.1"]);
  assert.deepEqual(result.allowedIPs, ["10.0.0.1", "192.168.1.1"]);
});

test("setWorkspaceIpPolicy trims whitespace", async () => {
  const result = await setWorkspaceIpPolicy("ws-ip-trim", ["  10.0.0.1  ", " 192.168.1.0/24 "]);
  assert.deepEqual(result.allowedIPs, ["10.0.0.1", "192.168.1.0/24"]);
});

// ---------------------------------------------------------------------------
// IP checking — exact match
// ---------------------------------------------------------------------------

test("checkWorkspaceIpAccess allows any IP when policy is disabled", async () => {
  // No policy set
  const result = await checkWorkspaceIpAccess("ws-no-policy", "1.2.3.4");
  assert.equal(result.allowed, true);
});

test("checkWorkspaceIpAccess allows matching exact IP", async () => {
  await setWorkspaceIpPolicy("ws-exact", ["10.0.0.1", "10.0.0.2"]);
  const result = await checkWorkspaceIpAccess("ws-exact", "10.0.0.1");
  assert.equal(result.allowed, true);
});

test("checkWorkspaceIpAccess blocks non-matching exact IP", async () => {
  await setWorkspaceIpPolicy("ws-exact-block", ["10.0.0.1"]);
  const result = await checkWorkspaceIpAccess("ws-exact-block", "10.0.0.2");
  assert.equal(result.allowed, false);
  assert.ok(result.reason);
});

// ---------------------------------------------------------------------------
// IP checking — CIDR support
// ---------------------------------------------------------------------------

test("checkWorkspaceIpAccess allows IP in /24 CIDR range", async () => {
  await setWorkspaceIpPolicy("ws-cidr24", ["192.168.1.0/24"]);
  const result = await checkWorkspaceIpAccess("ws-cidr24", "192.168.1.42");
  assert.equal(result.allowed, true);
});

test("checkWorkspaceIpAccess blocks IP outside /24 CIDR range", async () => {
  await setWorkspaceIpPolicy("ws-cidr24-block", ["192.168.1.0/24"]);
  const result = await checkWorkspaceIpAccess("ws-cidr24-block", "192.168.2.1");
  assert.equal(result.allowed, false);
});

test("checkWorkspaceIpAccess allows IP in /16 CIDR range", async () => {
  await setWorkspaceIpPolicy("ws-cidr16", ["10.20.0.0/16"]);
  const result = await checkWorkspaceIpAccess("ws-cidr16", "10.20.255.123");
  assert.equal(result.allowed, true);
});

test("checkWorkspaceIpAccess blocks IP outside /16 CIDR range", async () => {
  await setWorkspaceIpPolicy("ws-cidr16-block", ["10.20.0.0/16"]);
  const result = await checkWorkspaceIpAccess("ws-cidr16-block", "10.21.0.1");
  assert.equal(result.allowed, false);
});

test("checkWorkspaceIpAccess allows IP in /8 CIDR range", async () => {
  await setWorkspaceIpPolicy("ws-cidr8", ["10.0.0.0/8"]);
  const result = await checkWorkspaceIpAccess("ws-cidr8", "10.255.255.255");
  assert.equal(result.allowed, true);
});

test("checkWorkspaceIpAccess blocks IP outside /8 CIDR range", async () => {
  await setWorkspaceIpPolicy("ws-cidr8-block", ["10.0.0.0/8"]);
  const result = await checkWorkspaceIpAccess("ws-cidr8-block", "11.0.0.1");
  assert.equal(result.allowed, false);
});

test("checkWorkspaceIpAccess handles /32 (single host)", async () => {
  await setWorkspaceIpPolicy("ws-cidr32", ["10.0.0.5/32"]);

  const allowed = await checkWorkspaceIpAccess("ws-cidr32", "10.0.0.5");
  assert.equal(allowed.allowed, true);

  const blocked = await checkWorkspaceIpAccess("ws-cidr32", "10.0.0.6");
  assert.equal(blocked.allowed, false);
});

// ---------------------------------------------------------------------------
// IPv6-mapped addresses
// ---------------------------------------------------------------------------

test("checkWorkspaceIpAccess handles IPv6-mapped addresses", async () => {
  await setWorkspaceIpPolicy("ws-ipv6", ["127.0.0.1"]);
  const result = await checkWorkspaceIpAccess("ws-ipv6", "::ffff:127.0.0.1");
  assert.equal(result.allowed, true);
});

test("checkWorkspaceIpAccess handles IPv6-mapped with CIDR", async () => {
  await setWorkspaceIpPolicy("ws-ipv6-cidr", ["10.20.30.0/24"]);
  const result = await checkWorkspaceIpAccess("ws-ipv6-cidr", "::ffff:10.20.30.5");
  assert.equal(result.allowed, true);
});

// ---------------------------------------------------------------------------
// Multiple entries
// ---------------------------------------------------------------------------

test("checkWorkspaceIpAccess allows if any entry matches", async () => {
  await setWorkspaceIpPolicy("ws-multi", ["10.0.0.1", "192.168.0.0/16", "172.16.5.5"]);

  const r1 = await checkWorkspaceIpAccess("ws-multi", "10.0.0.1");
  assert.equal(r1.allowed, true);

  const r2 = await checkWorkspaceIpAccess("ws-multi", "192.168.99.42");
  assert.equal(r2.allowed, true);

  const r3 = await checkWorkspaceIpAccess("ws-multi", "172.16.5.5");
  assert.equal(r3.allowed, true);
});

test("checkWorkspaceIpAccess blocks if no entry matches", async () => {
  await setWorkspaceIpPolicy("ws-multi-block", ["10.0.0.1", "192.168.1.0/24"]);
  const result = await checkWorkspaceIpAccess("ws-multi-block", "172.16.0.1");
  assert.equal(result.allowed, false);
});
