/**
 * Phase 66.3: Fair rate limits tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-fair-rl-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerTenant,
  tryAcquire,
  getQueue,
  setWeights,
  listTenants,
  releaseSlot,
  loadPersistedTenants,
  _resetFairRateLimits,
} = await import("../lib/fair-rate-limits.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("registerTenant stores defaults for weight and priority", async () => {
  _resetFairRateLimits();
  const t = await registerTenant({ tenantId: "t1" });
  assert.equal(t.tenantId, "t1");
  assert.equal(t.weight, 1);
  assert.equal(t.priority, 0);
  assert.ok(t.capacity > 0);
});

test("registerTenant honors explicit weight and capacity", async () => {
  _resetFairRateLimits();
  const t = await registerTenant({ tenantId: "t2", weight: 3, priority: 2, capacity: 5 });
  assert.equal(t.weight, 3);
  assert.equal(t.priority, 2);
  assert.equal(t.capacity, 5);
});

test("registerTenant validates required fields", async () => {
  await assert.rejects(() => registerTenant({}));
  await assert.rejects(() => registerTenant(null));
});

test("tryAcquire succeeds while tokens are available", async () => {
  _resetFairRateLimits();
  await registerTenant({ tenantId: "worker", capacity: 3, refillPerSec: 0.0001 });
  const a = tryAcquire("worker");
  const b = tryAcquire("worker");
  const c = tryAcquire("worker");
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true);
  assert.equal(c.acquired, true);
});

test("tryAcquire enqueues when the bucket is empty", async () => {
  _resetFairRateLimits();
  await registerTenant({ tenantId: "slow", capacity: 1, refillPerSec: 0.0001 });
  tryAcquire("slow");
  const second = tryAcquire("slow");
  assert.equal(second.acquired, false);
  assert.equal(second.queued, true);
  const q = getQueue();
  assert.ok(q.size >= 1);
});

test("tryAcquire throws for unknown tenants", () => {
  _resetFairRateLimits();
  assert.throws(() => tryAcquire("never-registered"));
  assert.throws(() => tryAcquire(""));
});

test("releaseSlot decrements active count", async () => {
  _resetFairRateLimits();
  await registerTenant({ tenantId: "rel", capacity: 2, refillPerSec: 0.0001 });
  tryAcquire("rel");
  tryAcquire("rel");
  const ok = releaseSlot("rel");
  assert.equal(ok, true);
  const stats = listTenants({ includeStats: true });
  const rel = stats.find((t) => t.tenantId === "rel");
  assert.ok(rel);
  assert.equal(rel.active, 1);
});

test("getQueue is fair by weighted arrival order", async () => {
  _resetFairRateLimits();
  await registerTenant({ tenantId: "low", capacity: 1, refillPerSec: 0.0001, weight: 1 });
  await registerTenant({ tenantId: "high", capacity: 1, refillPerSec: 0.0001, weight: 5, priority: 1 });
  tryAcquire("low");
  tryAcquire("high");
  tryAcquire("low");
  tryAcquire("high");
  const q = getQueue();
  assert.ok(q.size >= 2);
  // The high-priority tenant should appear first in the queue due to boost.
  assert.equal(q.items[0].tenantId, "high");
});

test("setWeights updates existing tenants and creates missing ones", async () => {
  _resetFairRateLimits();
  await registerTenant({ tenantId: "sw1", weight: 1 });
  const updates = await setWeights([
    { tenantId: "sw1", weight: 5 },
    { tenantId: "sw2", weight: 2, priority: 1 },
  ]);
  assert.equal(updates.length, 2);
  const all = listTenants();
  const sw1 = all.find((t) => t.tenantId === "sw1");
  const sw2 = all.find((t) => t.tenantId === "sw2");
  assert.equal(sw1.weight, 5);
  assert.equal(sw2.priority, 1);
});

test("setWeights rejects non-arrays", async () => {
  await assert.rejects(() => setWeights(null));
});

test("listTenants includeStats returns token info", async () => {
  _resetFairRateLimits();
  await registerTenant({ tenantId: "ls1", capacity: 4 });
  tryAcquire("ls1");
  const stats = listTenants({ includeStats: true });
  const ls1 = stats.find((t) => t.tenantId === "ls1");
  assert.ok(ls1);
  assert.ok(typeof ls1.tokens === "number");
  assert.ok(typeof ls1.totalServed === "number");
});

test("loadPersistedTenants restores config from disk", async () => {
  _resetFairRateLimits();
  await registerTenant({ tenantId: "persisted", weight: 7, capacity: 3 });
  _resetFairRateLimits();
  const loaded = await loadPersistedTenants();
  assert.ok(loaded.find((t) => t.tenantId === "persisted"));
});
