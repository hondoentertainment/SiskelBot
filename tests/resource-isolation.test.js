/**
 * Phase 66.1: Resource isolation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-res-iso-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  setLimits,
  getLimits,
  recordUsage,
  checkQuota,
  listTenantUsage,
  resetUsage,
  RESOURCE_TYPES,
} = await import("../lib/resource-isolation.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("RESOURCE_TYPES exports a known list", () => {
  assert.ok(Array.isArray(RESOURCE_TYPES));
  assert.ok(RESOURCE_TYPES.includes("cpu_ms"));
  assert.ok(RESOURCE_TYPES.includes("memory_bytes"));
});

test("setLimits stores tenant quotas", async () => {
  const out = await setLimits("tenant-a", { cpu_ms: 1000, memory_bytes: 1024 * 1024 });
  assert.equal(out.tenantId, "tenant-a");
  assert.equal(out.limits.cpu_ms, 1000);
  const fetched = await getLimits("tenant-a");
  assert.ok(fetched);
  assert.equal(fetched.limits.cpu_ms, 1000);
  assert.equal(fetched.limits.memory_bytes, 1024 * 1024);
});

test("setLimits validates non-negative numbers", async () => {
  await assert.rejects(() => setLimits("", { cpu_ms: 1 }));
  await assert.rejects(() => setLimits("t", null));
  await assert.rejects(() => setLimits("t", { cpu_ms: -1 }));
});

test("recordUsage accumulates by default", async () => {
  await setLimits("tenant-b", { cpu_ms: 1000 });
  await recordUsage("tenant-b", "cpu_ms", 100);
  await recordUsage("tenant-b", "cpu_ms", 50);
  const check = await checkQuota("tenant-b", "cpu_ms", 0);
  assert.equal(check.currentUsage, 150);
});

test("recordUsage in set mode replaces", async () => {
  await setLimits("tenant-c", { cpu_ms: 1000 });
  await recordUsage("tenant-c", "cpu_ms", 500);
  await recordUsage("tenant-c", "cpu_ms", 200, { mode: "set" });
  const check = await checkQuota("tenant-c", "cpu_ms", 0);
  assert.equal(check.currentUsage, 200);
});

test("recordUsage clamps negatives to 0 on add", async () => {
  await setLimits("tenant-d", { concurrent: 10 });
  await recordUsage("tenant-d", "concurrent", 3);
  await recordUsage("tenant-d", "concurrent", -5);
  const check = await checkQuota("tenant-d", "concurrent", 0);
  assert.equal(check.currentUsage, 0);
});

test("checkQuota allows when under limit", async () => {
  await setLimits("tenant-e", { memory_bytes: 1000 });
  await recordUsage("tenant-e", "memory_bytes", 400);
  const result = await checkQuota("tenant-e", "memory_bytes", 500);
  assert.equal(result.allowed, true);
  assert.equal(result.projectedUsage, 900);
});

test("checkQuota denies when request would exceed", async () => {
  await setLimits("tenant-f", { memory_bytes: 1000 });
  await recordUsage("tenant-f", "memory_bytes", 800);
  const result = await checkQuota("tenant-f", "memory_bytes", 500);
  assert.equal(result.allowed, false);
  assert.ok(result.reason?.includes("memory_bytes"));
});

test("checkQuota returns allowed=true when tenant has no limits", async () => {
  const result = await checkQuota("unknown-tenant", "cpu_ms", 99);
  assert.equal(result.allowed, true);
  assert.equal(result.currentUsage, 0);
});

test("listTenantUsage returns all tenants and overLimitOnly filter works", async () => {
  await setLimits("over-tenant", { cpu_ms: 10 });
  await recordUsage("over-tenant", "cpu_ms", 100);
  const list = await listTenantUsage();
  assert.ok(list.length >= 1);
  const over = await listTenantUsage({ overLimitOnly: true });
  assert.ok(over.some((t) => t.tenantId === "over-tenant"));
  for (const t of over) assert.ok(t.overLimit.length > 0);
});

test("resetUsage clears counters", async () => {
  await setLimits("reset-tenant", { cpu_ms: 10000 });
  await recordUsage("reset-tenant", "cpu_ms", 500);
  await resetUsage("reset-tenant");
  const check = await checkQuota("reset-tenant", "cpu_ms", 0);
  assert.equal(check.currentUsage, 0);
});

test("resetUsage with specific resources only clears those", async () => {
  await setLimits("partial-reset", { cpu_ms: 10000, memory_bytes: 2000 });
  await recordUsage("partial-reset", "cpu_ms", 300);
  await recordUsage("partial-reset", "memory_bytes", 500);
  await resetUsage("partial-reset", ["cpu_ms"]);
  const cpu = await checkQuota("partial-reset", "cpu_ms", 0);
  const mem = await checkQuota("partial-reset", "memory_bytes", 0);
  assert.equal(cpu.currentUsage, 0);
  assert.equal(mem.currentUsage, 500);
});
