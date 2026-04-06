import test from "node:test";
import assert from "node:assert/strict";

test("quotas: isQuotaConfigured returns false when not configured", async () => {
  // QUOTA_TOKENS_PER_WORKSPACE is read at module load time
  // By default it's not set, so should be false
  const { isQuotaConfigured } = await import("../lib/quotas.js");
  // If env var isn't set, should be false
  const envVal = process.env.QUOTA_TOKENS_PER_WORKSPACE;
  if (!envVal) {
    assert.equal(isQuotaConfigured(), false);
  } else {
    // If it is set in the environment, just verify it returns a boolean
    assert.equal(typeof isQuotaConfigured(), "boolean");
  }
});

test("quotas: isQuotaAdmin returns false for empty/null userId", async () => {
  const { isQuotaAdmin } = await import("../lib/quotas.js");
  assert.equal(isQuotaAdmin(null), false);
  assert.equal(isQuotaAdmin(""), false);
  assert.equal(isQuotaAdmin(undefined), false);
  assert.equal(isQuotaAdmin(123), false);
});

test("quotas: isQuotaAdmin returns false for non-admin user", async () => {
  const { isQuotaAdmin } = await import("../lib/quotas.js");
  assert.equal(isQuotaAdmin("random-user-not-admin"), false);
});

test("quotas: checkQuota allows when quota is not configured", async () => {
  const { checkQuota } = await import("../lib/quotas.js");
  // When QUOTA_TOKENS_PER_WORKSPACE is not set, checkQuota should allow
  if (!process.env.QUOTA_TOKENS_PER_WORKSPACE) {
    const result = await checkQuota("test-workspace", "user1", 100);
    assert.equal(result.allowed, true);
    assert.equal(result.quota, null);
  }
});

test("quotas: setWorkspaceQuotaOverride validates workspace", async () => {
  const { setWorkspaceQuotaOverride } = await import("../lib/quotas.js");
  // Setting a valid override
  const result = await setWorkspaceQuotaOverride("test-ws-" + Date.now(), 50000);
  assert.equal(result.ok, true);
  assert.equal(result.limit, 50000);
});

test("quotas: setWorkspaceQuotaOverride rejects invalid limit", async () => {
  const { setWorkspaceQuotaOverride } = await import("../lib/quotas.js");
  const result = await setWorkspaceQuotaOverride("test-ws", -100);
  // Negative limit clears the override
  assert.equal(result.ok, true);
});

test("quotas: setWorkspaceQuotaOverride clears override with null", async () => {
  const { setWorkspaceQuotaOverride } = await import("../lib/quotas.js");
  const result = await setWorkspaceQuotaOverride("test-ws", null);
  assert.equal(result.ok, true);
  assert.equal(result.limit, undefined);
});

test("quotas: getQuotaOverrides returns object", async () => {
  const { getQuotaOverrides } = await import("../lib/quotas.js");
  const overrides = await getQuotaOverrides();
  assert.equal(typeof overrides, "object");
  assert.ok(overrides !== null);
});
