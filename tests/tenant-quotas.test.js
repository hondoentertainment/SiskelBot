/**
 * Per-tenant rate limit / quota tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  checkQuota,
  recordRequest,
  recordTokens,
  getUsageSnapshot,
  __resetForTests,
} from "../lib/tenant-quotas.js";

// Build a mock storage with a configurable override map.
function mockStorage(overrides = {}) {
  return {
    async get(type, id /*, workspace, userId */) {
      if (type !== "tenant_quotas") return null;
      return overrides[id] || null;
    },
    async list(type, workspace /*, userId */) {
      if (type !== "tenant_quotas") return [];
      const o = overrides[workspace];
      return o ? [o] : [];
    },
    async listWorkspaces() {
      return Object.keys(overrides).map((id) => ({ workspace: { id } }));
    },
    async add() {
      // not used in these tests
    },
    async remove() {
      // not used in these tests
    },
  };
}

test("tenant-quotas: fresh workspace under default quota allows requests", async () => {
  __resetForTests();
  const result = await checkQuota("ws-fresh", { storage: mockStorage() });
  assert.equal(result.allowed, true);
  assert.equal(typeof result.limits.requestsPerMinute, "number");
  assert.equal(typeof result.limits.tokensPerDay, "number");
  assert.equal(result.currentUsage.requestsThisMinute, 0);
  assert.equal(result.currentUsage.tokensToday, 0);
});

test("tenant-quotas: workspace at request limit returns denied with retryAfter <= 60", async () => {
  __resetForTests();
  const prev = process.env.DEFAULT_REQUESTS_PER_MINUTE;
  process.env.DEFAULT_REQUESTS_PER_MINUTE = "3";
  try {
    const ws = "ws-rate";
    // First three requests should be allowed.
    for (let i = 0; i < 3; i++) {
      const r = await checkQuota(ws, { storage: mockStorage() });
      assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
      recordRequest(ws);
    }
    const blocked = await checkQuota(ws, { storage: mockStorage() });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "requests_per_minute_exceeded");
    assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 60, `retryAfter=${blocked.retryAfter}`);
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_REQUESTS_PER_MINUTE;
    else process.env.DEFAULT_REQUESTS_PER_MINUTE = prev;
  }
});

test("tenant-quotas: token quota is enforced separately from request quota", async () => {
  __resetForTests();
  const prevTok = process.env.DEFAULT_TOKENS_PER_DAY;
  const prevReq = process.env.DEFAULT_REQUESTS_PER_MINUTE;
  process.env.DEFAULT_TOKENS_PER_DAY = "100";
  process.env.DEFAULT_REQUESTS_PER_MINUTE = "1000"; // request limit far above token limit
  try {
    const ws = "ws-tokens";
    // Burn through token budget.
    recordRequest(ws);
    recordTokens(ws, 150);
    const r = await checkQuota(ws, { storage: mockStorage() });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "tokens_per_day_exceeded");
    assert.ok(r.retryAfter > 0);
  } finally {
    if (prevTok === undefined) delete process.env.DEFAULT_TOKENS_PER_DAY;
    else process.env.DEFAULT_TOKENS_PER_DAY = prevTok;
    if (prevReq === undefined) delete process.env.DEFAULT_REQUESTS_PER_MINUTE;
    else process.env.DEFAULT_REQUESTS_PER_MINUTE = prevReq;
  }
});

test("tenant-quotas: per-workspace override from storage takes precedence over env defaults", async () => {
  __resetForTests();
  const prev = process.env.DEFAULT_REQUESTS_PER_MINUTE;
  process.env.DEFAULT_REQUESTS_PER_MINUTE = "60";
  try {
    const ws = "ws-override";
    const storage = mockStorage({
      [ws]: { id: ws, workspaceId: ws, requestsPerMinute: 5, tokensPerDay: 999 },
    });
    const r = await checkQuota(ws, { storage });
    assert.equal(r.allowed, true);
    assert.equal(r.limits.requestsPerMinute, 5, "override should beat env default");
    assert.equal(r.limits.tokensPerDay, 999);
  } finally {
    if (prev === undefined) delete process.env.DEFAULT_REQUESTS_PER_MINUTE;
    else process.env.DEFAULT_REQUESTS_PER_MINUTE = prev;
  }
});

test("tenant-quotas: rolling window resets after expiration", async () => {
  __resetForTests();
  const prev = process.env.DEFAULT_REQUESTS_PER_MINUTE;
  process.env.DEFAULT_REQUESTS_PER_MINUTE = "2";
  const realNow = Date.now;
  let fakeNow = 1_700_000_000_000;
  Date.now = () => fakeNow;
  try {
    const ws = "ws-window";
    // Saturate at t=0
    recordRequest(ws);
    recordRequest(ws);
    let r = await checkQuota(ws, { storage: mockStorage() });
    assert.equal(r.allowed, false, "should be blocked at limit");
    // Advance time past the 60s window.
    fakeNow += 61_000;
    r = await checkQuota(ws, { storage: mockStorage() });
    assert.equal(r.allowed, true, "should be allowed after window roll");
    assert.equal(r.currentUsage.requestsThisMinute, 0, "counter should reset");
  } finally {
    Date.now = realNow;
    if (prev === undefined) delete process.env.DEFAULT_REQUESTS_PER_MINUTE;
    else process.env.DEFAULT_REQUESTS_PER_MINUTE = prev;
  }
});

test("tenant-quotas: getUsageSnapshot reflects recorded counters", async () => {
  __resetForTests();
  const ws = "ws-snap";
  recordRequest(ws);
  recordRequest(ws);
  recordTokens(ws, 250);
  const snap = getUsageSnapshot(ws);
  assert.equal(snap.requestsThisMinute, 2);
  assert.equal(snap.tokensToday, 250);
  assert.equal(snap.storageBytes, 0);
});

test("tenant-quotas: storage failure falls back to defaults (fail open)", async () => {
  __resetForTests();
  const broken = {
    async get() {
      throw new Error("storage offline");
    },
  };
  const r = await checkQuota("ws-broken", { storage: broken });
  assert.equal(r.allowed, true);
  assert.equal(typeof r.limits.requestsPerMinute, "number");
});
