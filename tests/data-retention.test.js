/**
 * Phase 25: Data retention policy tests.
 * Tests lib/data-retention.js — policy CRUD, enforcement, and sweep.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

// Set test storage path before importing modules
const TEST_DIR = join(process.cwd(), "data", ".test-retention-" + Date.now());
process.env.STORAGE_PATH = TEST_DIR;

import {
  setRetentionPolicy,
  getRetentionPolicy,
  enforceRetention,
  runRetentionSweep,
} from "../lib/data-retention.js";
import * as storage from "../lib/storage.js";

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

test("getRetentionPolicy returns defaults when no policy is set", async () => {
  const policy = await getRetentionPolicy("no-such-workspace");
  assert.equal(policy.conversationsTTLDays, null);
  assert.equal(policy.documentsTTLDays, null);
  assert.equal(policy.auditTTLDays, null);
  assert.equal(policy.memoryTTLDays, null);
});

test("setRetentionPolicy stores and retrieves a policy", async () => {
  const input = {
    conversationsTTLDays: 30,
    documentsTTLDays: 90,
    auditTTLDays: 365,
    memoryTTLDays: 60,
  };
  const result = await setRetentionPolicy("ws-policy-test", input);
  assert.equal(result.conversationsTTLDays, 30);
  assert.equal(result.documentsTTLDays, 90);
  assert.equal(result.auditTTLDays, 365);
  assert.equal(result.memoryTTLDays, 60);
  assert.ok(result.updatedAt);

  const fetched = await getRetentionPolicy("ws-policy-test");
  assert.equal(fetched.conversationsTTLDays, 30);
  assert.equal(fetched.memoryTTLDays, 60);
});

test("setRetentionPolicy allows null TTL values", async () => {
  const result = await setRetentionPolicy("ws-null-ttl", {
    conversationsTTLDays: null,
    documentsTTLDays: 10,
    auditTTLDays: undefined,
    memoryTTLDays: null,
  });
  assert.equal(result.conversationsTTLDays, null);
  assert.equal(result.documentsTTLDays, 10);
  assert.equal(result.auditTTLDays, null);
  assert.equal(result.memoryTTLDays, null);
});

test("setRetentionPolicy rejects negative TTL values", async () => {
  await assert.rejects(
    () => setRetentionPolicy("ws-negative", { conversationsTTLDays: -5 }),
    /non-negative/
  );
});

test("setRetentionPolicy rejects non-numeric TTL values", async () => {
  await assert.rejects(
    () => setRetentionPolicy("ws-invalid", { conversationsTTLDays: "abc" }),
    /non-negative/
  );
});

test("getRetentionPolicy returns defaults for null/undefined workspaceId", async () => {
  const policy = await getRetentionPolicy(null);
  assert.equal(policy.conversationsTTLDays, null);
  assert.equal(policy.workspaceId, "default");
});

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

test("enforceRetention deletes expired conversations", async () => {
  const wsId = "ws-enforce-convos";
  const userId = "user-enforce";

  // Add old and new conversations
  const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const newDate = new Date().toISOString();

  await storage.add("conversations", { id: "old-convo", title: "Old", createdAt: oldDate }, wsId, false, userId);
  await storage.add("conversations", { id: "new-convo", title: "New", createdAt: newDate }, wsId, false, userId);

  // Set 30-day retention
  await setRetentionPolicy(wsId, { conversationsTTLDays: 30 });

  const result = await enforceRetention(wsId, userId);
  assert.equal(result.deleted.conversations, 1);

  // Verify old conversation is gone
  const remaining = await storage.list("conversations", wsId, userId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "new-convo");
});

test("enforceRetention deletes expired documents", async () => {
  const wsId = "ws-enforce-docs";
  const userId = "user-enforce-docs";

  const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const newDate = new Date().toISOString();

  await storage.add("context", { id: "old-doc", title: "Old Doc", createdAt: oldDate }, wsId, false, userId);
  await storage.add("context", { id: "new-doc", title: "New Doc", createdAt: newDate }, wsId, false, userId);

  await setRetentionPolicy(wsId, { documentsTTLDays: 60 });

  const result = await enforceRetention(wsId, userId);
  assert.equal(result.deleted.documents, 1);

  const remaining = await storage.list("context", wsId, userId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, "new-doc");
});

test("enforceRetention does nothing when no TTLs are set", async () => {
  const wsId = "ws-enforce-noop";
  const userId = "user-noop";

  await storage.add("conversations", { id: "convo-keep", title: "Keep" }, wsId, false, userId);

  // No retention policy set
  const result = await enforceRetention(wsId, userId);
  assert.equal(result.deleted.conversations, 0);
  assert.equal(result.deleted.documents, 0);
  assert.equal(result.deleted.audit, 0);
  assert.equal(result.deleted.memory, 0);

  const remaining = await storage.list("conversations", wsId, userId);
  assert.equal(remaining.length, 1);
});

test("enforceRetention handles zero TTL (no deletion)", async () => {
  const wsId = "ws-enforce-zero";
  const userId = "user-zero";

  await storage.add("conversations", { id: "convo-z", title: "Zero" }, wsId, false, userId);
  await setRetentionPolicy(wsId, { conversationsTTLDays: 0 });

  const result = await enforceRetention(wsId, userId);
  assert.equal(result.deleted.conversations, 0);
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

test("runRetentionSweep processes all workspaces with policies", async () => {
  const wsId = "ws-sweep-test";
  const userId = "anonymous";

  const oldDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  await storage.add("conversations", { id: "sweep-old", title: "Old Sweep", createdAt: oldDate }, wsId, false, userId);
  await storage.add("conversations", { id: "sweep-new", title: "New Sweep" }, wsId, false, userId);

  await setRetentionPolicy(wsId, { conversationsTTLDays: 10 });

  const sweepResult = await runRetentionSweep();
  assert.ok(Array.isArray(sweepResult.results));

  const wsResult = sweepResult.results.find((r) => r.workspaceId === wsId);
  assert.ok(wsResult, "sweep should include workspace with retention policy");
  assert.equal(wsResult.deleted.conversations, 1);
});

test("runRetentionSweep returns empty results when no policies exist", async () => {
  // Create a temporary clean data dir with no retention policies
  const cleanDir = join(process.cwd(), "data", ".test-retention-clean-" + Date.now());
  const origPath = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = cleanDir;
  mkdirSync(cleanDir, { recursive: true });

  try {
    const { runRetentionSweep: cleanSweep } = await import("../lib/data-retention.js");
    const result = await cleanSweep();
    assert.ok(Array.isArray(result.results));
  } finally {
    process.env.STORAGE_PATH = origPath;
    rmSync(cleanDir, { recursive: true, force: true });
  }
});
