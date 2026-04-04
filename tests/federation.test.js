/**
 * Tests for federated deployment (lib/federation.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-federation-"));
process.env.STORAGE_PATH = tempDir;
process.env.FEDERATION_SECRET = "test-shared-secret-for-federation";

import {
  signPayload,
  verifySignature,
  federationAuth,
  registerPeer,
  removePeer,
  listPeers,
  healthCheckPeers,
  discoverFederatedWorkspaces,
  syncWorkspaceMetadata,
  handleDiscoverRequest,
  getInstanceInfo,
  forwardToPeer,
} from "../lib/federation.js";

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

// --- HMAC Signing ---

test("signPayload produces a hex signature", () => {
  const sig = signPayload({ hello: "world" });
  assert.ok(typeof sig === "string");
  assert.ok(/^[a-f0-9]{64}$/.test(sig), "Should be 64 hex chars (sha256)");
});

test("verifySignature validates correct signature", () => {
  const payload = { foo: "bar" };
  const sig = signPayload(payload);
  assert.ok(verifySignature(payload, sig));
});

test("verifySignature rejects incorrect signature", () => {
  const payload = { foo: "bar" };
  assert.ok(!verifySignature(payload, "0".repeat(64)));
});

test("verifySignature rejects empty secret", () => {
  assert.ok(!verifySignature("test", "abc", ""));
});

test("signPayload with string payload", () => {
  const sig = signPayload("raw string body");
  assert.ok(verifySignature("raw string body", sig));
});

// --- Federation Auth Middleware ---

test("federationAuth rejects missing signature", () => {
  let statusCode, jsonBody;
  const req = { headers: {}, body: {} };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; },
  };
  federationAuth(req, res, () => {});
  assert.equal(statusCode, 401);
  assert.equal(jsonBody.code, "FEDERATION_AUTH_REQUIRED");
});

test("federationAuth rejects invalid signature", () => {
  let statusCode;
  const req = {
    headers: { "x-federation-signature": "invalid" },
    body: { test: true },
  };
  const res = {
    status(code) { statusCode = code; return this; },
    json() {},
  };
  federationAuth(req, res, () => {});
  assert.equal(statusCode, 403);
});

test("federationAuth accepts valid signature", () => {
  const body = { test: true };
  const sig = signPayload(body);
  let nextCalled = false;
  const req = {
    headers: { "x-federation-signature": sig },
    body,
  };
  const res = {
    status() { return this; },
    json() {},
  };
  federationAuth(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
});

// --- Peer Registration ---

test("registerPeer registers a new peer", async () => {
  // The peer URL won't be reachable, but registration should still work
  const peer = await registerPeer("https://peer1.example.com");
  assert.ok(peer.id);
  assert.equal(peer.url, "https://peer1.example.com");
  assert.equal(peer.status, "active");
  assert.ok(peer.registeredAt);
});

test("registerPeer deduplicates by URL", async () => {
  const peer2 = await registerPeer("https://peer1.example.com");
  const peers = await listPeers();
  const matching = peers.filter((p) => p.url === "https://peer1.example.com");
  assert.equal(matching.length, 1);
  assert.equal(peer2.url, "https://peer1.example.com");
});

test("registerPeer strips trailing slashes", async () => {
  const peer = await registerPeer("https://peer2.example.com///");
  assert.equal(peer.url, "https://peer2.example.com");
});

test("listPeers returns all registered peers", async () => {
  const peers = await listPeers();
  assert.ok(peers.length >= 2);
  assert.ok(peers.find((p) => p.url === "https://peer1.example.com"));
  assert.ok(peers.find((p) => p.url === "https://peer2.example.com"));
});

test("removePeer removes a peer", async () => {
  const peers = await listPeers();
  const peer2 = peers.find((p) => p.url === "https://peer2.example.com");
  const removed = await removePeer(peer2.id);
  assert.ok(removed);
  const after = await listPeers();
  assert.ok(!after.find((p) => p.url === "https://peer2.example.com"));
});

test("removePeer returns false for unknown id", async () => {
  const removed = await removePeer("nonexistent-id");
  assert.equal(removed, false);
});

// --- Health Check ---

test("healthCheckPeers marks unreachable peers", async () => {
  const results = await healthCheckPeers();
  assert.ok(results.length > 0);
  // Our test peers are not real, so they should be unreachable
  for (const peer of results) {
    assert.equal(peer.status, "unreachable");
  }
});

// --- Workspace Discovery ---

test("syncWorkspaceMetadata stores discoverable workspace", async () => {
  const result = await syncWorkspaceMetadata("ws-fed-1", {
    name: "Shared Project",
    description: "A cross-team project workspace",
    discoverable: true,
  });
  assert.equal(result.workspaceId, "ws-fed-1");
  assert.equal(result.name, "Shared Project");
  assert.equal(result.discoverable, true);
});

test("syncWorkspaceMetadata updates existing entry", async () => {
  const result = await syncWorkspaceMetadata("ws-fed-1", {
    name: "Updated Project",
    description: "Updated description",
    discoverable: true,
  });
  assert.equal(result.name, "Updated Project");
});

test("handleDiscoverRequest returns discoverable workspaces", async () => {
  const workspaces = await handleDiscoverRequest(null);
  assert.ok(workspaces.length > 0);
  assert.ok(workspaces.find((w) => w.workspaceId === "ws-fed-1"));
});

test("handleDiscoverRequest filters by query", async () => {
  await syncWorkspaceMetadata("ws-fed-2", {
    name: "Marketing Hub",
    description: "Marketing team workspace",
    discoverable: true,
  });
  const results = await handleDiscoverRequest("marketing");
  assert.ok(results.find((w) => w.workspaceId === "ws-fed-2"));
  assert.ok(!results.find((w) => w.workspaceId === "ws-fed-1"));
});

test("handleDiscoverRequest excludes non-discoverable workspaces", async () => {
  await syncWorkspaceMetadata("ws-fed-private", {
    name: "Private Workspace",
    description: "Not discoverable",
    discoverable: false,
  });
  const results = await handleDiscoverRequest(null);
  assert.ok(!results.find((w) => w.workspaceId === "ws-fed-private"));
});

test("discoverFederatedWorkspaces includes local workspaces", async () => {
  const results = await discoverFederatedWorkspaces(null);
  assert.ok(results.length > 0);
  const local = results.filter((r) => r.source === "local");
  assert.ok(local.length > 0);
});

test("discoverFederatedWorkspaces filters by query", async () => {
  const results = await discoverFederatedWorkspaces("marketing");
  const match = results.find((r) => r.workspaceId === "ws-fed-2");
  assert.ok(match);
});

// --- Instance Info ---

test("getInstanceInfo returns instance details", () => {
  const info = getInstanceInfo();
  assert.ok(info.instanceId);
  assert.ok(info.region);
  assert.ok(info.name);
  assert.ok(info.timestamp);
});

// --- forwardToPeer ---

test("forwardToPeer rejects unknown peer", async () => {
  await assert.rejects(() => forwardToPeer("unknown-id", "GET", "/test"), /not found/i);
});

test("forwardToPeer rejects unreachable peer", async () => {
  const peers = await listPeers();
  const peer = peers.find((p) => p.status === "unreachable");
  if (peer) {
    await assert.rejects(() => forwardToPeer(peer.id, "GET", "/test"), /unreachable/i);
  }
});
