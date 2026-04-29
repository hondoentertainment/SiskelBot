/**
 * Plan-tier enforcement tests.
 * Covers getEffectiveQuotas, checkStorageQuota, and checkQuota with plan-based limits.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  checkQuota,
  recordRequest,
  recordTokens,
  recordStorageBytes,
  getEffectiveQuotas,
  checkStorageQuota,
  __resetForTests,
} from "../lib/tenant-quotas.js";

/**
 * Build a mock storage that can serve:
 *  - billing:<workspaceId> → { plan } records
 *  - tenant_quotas records (admin overrides)
 */
function mockStorage({ billingPlan, quotaOverride } = {}) {
  return {
    async get(type, id /*, workspace, userId */) {
      if (type === "tenant_quotas") {
        return quotaOverride && quotaOverride[id] ? quotaOverride[id] : null;
      }
      // billing lookup: type = "billing:<wsId>", id = "default"
      if (typeof type === "string" && type.startsWith("billing:")) {
        const wsId = type.slice("billing:".length);
        if (billingPlan && billingPlan[wsId]) {
          return { plan: billingPlan[wsId] };
        }
      }
      return null;
    },
    async list(type, workspace /*, userId */) {
      if (type !== "tenant_quotas") return [];
      if (quotaOverride && quotaOverride[workspace]) return [quotaOverride[workspace]];
      return [];
    },
    async listWorkspaces() {
      return [];
    },
    async add() {},
    async remove() {},
  };
}

test("plan-tier: free plan workspace gets free limits when no admin override", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-free": "free" } });
  const q = await getEffectiveQuotas("ws-free", storage);
  assert.equal(q.plan, "free");
  assert.equal(q.requestsPerMinute, 10);
  assert.equal(q.tokensPerDay, 50_000);
  assert.equal(q.storageBytes, 100 * 1024 * 1024);
  assert.equal(q.source, "plan");
});

test("plan-tier: pro plan workspace gets pro limits", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-pro": "pro" } });
  const q = await getEffectiveQuotas("ws-pro", storage);
  assert.equal(q.plan, "pro");
  assert.equal(q.requestsPerMinute, 60);
  assert.equal(q.tokensPerDay, 1_000_000);
  assert.equal(q.storageBytes, 5 * 1024 * 1024 * 1024);
  assert.equal(q.source, "plan");
});

test("plan-tier: enterprise plan workspace gets enterprise limits", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-ent": "enterprise" } });
  const q = await getEffectiveQuotas("ws-ent", storage);
  assert.equal(q.plan, "enterprise");
  assert.equal(q.requestsPerMinute, 300);
  assert.equal(q.tokensPerDay, 10_000_000);
  assert.equal(q.storageBytes, 50 * 1024 * 1024 * 1024);
  assert.equal(q.source, "plan");
});

test("plan-tier: no subscription found → workspace defaults to free plan label", async () => {
  __resetForTests();
  const storage = mockStorage(); // no billing entry
  const q = await getEffectiveQuotas("ws-unknown", storage);
  // plan label is "free" even with no billing record
  assert.equal(q.plan, "free");
  // limits come from env defaults when no billing record exists (fail open / backward compat)
  assert.equal(typeof q.requestsPerMinute, "number");
  assert.ok(q.requestsPerMinute > 0, "requestsPerMinute must be positive");
  assert.equal(q.source, "plan");
});

test("plan-tier: admin override takes precedence over plan limits for that field", async () => {
  __resetForTests();
  const storage = mockStorage({
    billingPlan: { "ws-override": "pro" },
    quotaOverride: {
      "ws-override": {
        id: "ws-override",
        workspaceId: "ws-override",
        requestsPerMinute: 200,  // higher than pro's 60
        tokensPerDay: 500_000,   // lower than pro's 1M
      },
    },
  });
  const q = await getEffectiveQuotas("ws-override", storage);
  assert.equal(q.plan, "pro", "plan label should still reflect subscription");
  assert.equal(q.requestsPerMinute, 200, "override should beat plan limit");
  assert.equal(q.tokensPerDay, 500_000, "override should beat plan limit");
  assert.equal(q.storageBytes, 5 * 1024 * 1024 * 1024, "unoverridden field keeps plan value");
  assert.equal(q.source, "override");
});

test("plan-tier: partial admin override leaves unset fields at plan defaults", async () => {
  __resetForTests();
  const storage = mockStorage({
    billingPlan: { "ws-partial": "enterprise" },
    quotaOverride: {
      "ws-partial": {
        id: "ws-partial",
        workspaceId: "ws-partial",
        requestsPerMinute: 999,
      },
    },
  });
  const q = await getEffectiveQuotas("ws-partial", storage);
  assert.equal(q.requestsPerMinute, 999, "overridden field");
  assert.equal(q.tokensPerDay, 10_000_000, "enterprise default for unoverridden field");
  assert.equal(q.storageBytes, 50 * 1024 * 1024 * 1024, "enterprise default for unoverridden field");
});

test("plan-tier: storage quota allows when under limit", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-stor": "free" } });
  recordStorageBytes("ws-stor", 50 * 1024 * 1024); // 50MB used
  const result = await checkStorageQuota("ws-stor", 10 * 1024 * 1024, storage); // +10MB
  assert.equal(result.allowed, true, "60MB total is under free 100MB limit");
  assert.equal(result.plan, "free");
  assert.equal(result.current, 50 * 1024 * 1024);
  assert.equal(result.limit, 100 * 1024 * 1024);
});

test("plan-tier: storage quota enforcement blocks when over limit", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-stor2": "free" } });
  recordStorageBytes("ws-stor2", 95 * 1024 * 1024); // 95MB used
  const result = await checkStorageQuota("ws-stor2", 10 * 1024 * 1024, storage); // +10MB = 105MB > 100MB
  assert.equal(result.allowed, false, "105MB exceeds free 100MB limit");
  assert.equal(result.plan, "free");
});

test("plan-tier: storage quota allows more on pro plan", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-pro-stor": "pro" } });
  recordStorageBytes("ws-pro-stor", 4 * 1024 * 1024 * 1024); // 4GB used
  const result = await checkStorageQuota("ws-pro-stor", 500 * 1024 * 1024, storage); // +500MB
  assert.equal(result.allowed, true, "4.5GB is under pro 5GB limit");
});

test("plan-tier: checkQuota uses plan-based limits for requests", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-req-free": "free" } });
  // Free plan allows 10 req/min. Record 10, next should be blocked.
  for (let i = 0; i < 10; i++) {
    const r = await checkQuota("ws-req-free", { storage });
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
    recordRequest("ws-req-free");
  }
  const blocked = await checkQuota("ws-req-free", { storage });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "requests_per_minute_exceeded");
});

test("plan-tier: checkQuota uses plan-based token limits", async () => {
  __resetForTests();
  const storage = mockStorage({ billingPlan: { "ws-tok-free": "free" } });
  recordTokens("ws-tok-free", 50_001); // over free 50k limit
  const r = await checkQuota("ws-tok-free", { storage });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "tokens_per_day_exceeded");
});

test("plan-tier: storage failure falls back gracefully (fail open)", async () => {
  __resetForTests();
  const broken = {
    async get() { throw new Error("storage offline"); },
  };
  const q = await getEffectiveQuotas("ws-broken-plan", broken);
  assert.equal(q.plan, "free");
  assert.equal(typeof q.requestsPerMinute, "number");
  assert.ok(q.requestsPerMinute > 0);
  assert.equal(q.source, "plan");
});
