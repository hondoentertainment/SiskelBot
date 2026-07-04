/**
 * Quota resolver tests: unified reporting across the three quota layers.
 * Uses a temp STORAGE_PATH; layers are exercised via their own public APIs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-qresolver-"));
process.env.STORAGE_PATH = tempDir;
delete process.env.QUOTA_ENABLED;
delete process.env.QUOTA_TOKENS_PER_WORKSPACE;

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("resolver reports all three layers for a fresh workspace", async () => {
  const { resolveQuotas } = await import("../lib/quota-resolver.js");
  const q = await resolveQuotas("fresh-ws");
  assert.equal(q.workspaceId, "fresh-ws");
  assert.equal(q.allowed, true);
  // Plan layer present (free plan) but not enforced without QUOTA_ENABLED.
  assert.equal(q.layers.planMonthly.plan, "free");
  assert.equal(q.layers.planMonthly.enforced, false);
  // Workspace override layer absent without QUOTA_TOKENS_PER_WORKSPACE.
  assert.equal(q.layers.workspaceMonthly, null);
  // Tenant layer always reports limits + live usage.
  assert.ok(q.layers.tenant.requestsPerMinute.limit > 0);
  assert.equal(q.layers.tenant.requestsPerMinute.used, 0);
  assert.ok(q.layers.tenant.tokensPerDay.limit > 0);
});

test("effectiveMonthlyTokens is the tightest configured monthly cap", async () => {
  process.env.QUOTA_ENABLED = "1";
  const { resolveQuotas } = await import("../lib/quota-resolver.js");
  const q = await resolveQuotas("cap-ws");
  // Free plan = 100K/month; no workspace override configured.
  assert.equal(q.effectiveMonthlyTokens, 100_000);
  assert.equal(q.layers.planMonthly.enforced, true);
  delete process.env.QUOTA_ENABLED;
});

test("tenant layer reflects recorded usage", async () => {
  const { recordRequest, recordTokens } = await import("../lib/tenant-quotas.js");
  const { resolveQuotas } = await import("../lib/quota-resolver.js");
  recordRequest("busy-ws");
  recordRequest("busy-ws");
  recordTokens("busy-ws", 1234);
  const q = await resolveQuotas("busy-ws");
  assert.equal(q.layers.tenant.requestsPerMinute.used, 2);
  assert.equal(q.layers.tenant.tokensPerDay.used, 1234);
});

test("paid plan raises the effective monthly cap", async () => {
  process.env.QUOTA_ENABLED = "1";
  const { setPlan } = await import("../lib/plans.js");
  const { resolveQuotas } = await import("../lib/quota-resolver.js");
  await setPlan("paid-ws", "pro");
  const q = await resolveQuotas("paid-ws");
  assert.equal(q.effectiveMonthlyTokens, 1_000_000);
  assert.equal(q.layers.planMonthly.plan, "pro");
  delete process.env.QUOTA_ENABLED;
});
