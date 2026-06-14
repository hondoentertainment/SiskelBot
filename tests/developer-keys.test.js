/**
 * Phase 34.4: Developer keys tests.
 *
 * Exercises registration, verification, key create/list/revoke, tier limits,
 * usage recording, and tier upgrades. Uses a temporary STORAGE_PATH so test
 * state does not leak into the developer store used by the live server.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate storage for this test file.
const tmpDir = mkdtempSync(join(tmpdir(), "developer-keys-test-"));
process.env.STORAGE_PATH = tmpDir;
// Ensure email is not configured so verification tokens are returned.
delete process.env.SMTP_HOST;

const {
  DEVELOPER_TIERS,
  registerDeveloper,
  verifyDeveloper,
  getDeveloper,
  createDeveloperKey,
  listDeveloperKeys,
  revokeDeveloperKey,
  getDeveloperUsage,
  upgradeDeveloperTier,
  checkDeveloperLimits,
  recordDeveloperRequest,
  findDeveloperByRawKey,
  _resetDeveloperKeysForTesting,
  _resetDeveloperRateBucketsForTesting,
} = await import("../lib/developer-keys.js");

async function freshDeveloper(email, name = "Test User") {
  const reg = await registerDeveloper(email, name);
  assert.equal(reg.ok, true, `register failed: ${reg.error}`);
  const ver = await verifyDeveloper(reg.developerId, reg.verificationToken);
  assert.equal(ver.ok, true, `verify failed: ${ver.error}`);
  return reg.developerId;
}

test.beforeEach(async () => {
  await _resetDeveloperKeysForTesting();
  _resetDeveloperRateBucketsForTesting();
});

test.after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test("developer-keys: DEVELOPER_TIERS includes free, pro, enterprise", () => {
  assert.ok(DEVELOPER_TIERS.free);
  assert.ok(DEVELOPER_TIERS.pro);
  assert.ok(DEVELOPER_TIERS.enterprise);
  assert.equal(DEVELOPER_TIERS.free.monthlyRequests, 10_000);
  assert.equal(DEVELOPER_TIERS.pro.monthlyRequests, 1_000_000);
  assert.equal(DEVELOPER_TIERS.enterprise.monthlyRequests, Infinity);
});

test("developer-keys: registerDeveloper validates email and name", async () => {
  assert.equal((await registerDeveloper("", "Name")).ok, false);
  assert.equal((await registerDeveloper("not-an-email", "Name")).ok, false);
  assert.equal((await registerDeveloper("ok@example.com", "")).ok, false);
});

test("developer-keys: registerDeveloper returns verification token without SMTP", async () => {
  const res = await registerDeveloper("alpha@example.com", "Alpha");
  assert.equal(res.ok, true);
  assert.ok(res.developerId.startsWith("dev_"));
  assert.equal(res.verified, false);
  assert.ok(res.verificationToken, "verification token should be returned when SMTP not configured");
});

test("developer-keys: duplicate email is rejected", async () => {
  const first = await registerDeveloper("dup@example.com", "First");
  assert.equal(first.ok, true);
  const second = await registerDeveloper("dup@example.com", "Second");
  assert.equal(second.ok, false);
  assert.match(second.error, /already exists/i);
});

test("developer-keys: verifyDeveloper requires correct token", async () => {
  const reg = await registerDeveloper("verify@example.com", "Verify");
  const bad = await verifyDeveloper(reg.developerId, "wrong-token");
  assert.equal(bad.ok, false);
  const good = await verifyDeveloper(reg.developerId, reg.verificationToken);
  assert.equal(good.ok, true);
  assert.equal(good.verified, true);
});

test("developer-keys: cannot create key for unverified developer", async () => {
  const reg = await registerDeveloper("unv@example.com", "Unverified");
  const res = await createDeveloperKey(reg.developerId, "mykey");
  assert.equal(res.ok, false);
  assert.match(res.error, /not verified/i);
});

test("developer-keys: createDeveloperKey issues one-time raw key with skdev- prefix", async () => {
  const dev = await freshDeveloper("create@example.com");
  const res = await createDeveloperKey(dev, "Prod key");
  assert.equal(res.ok, true);
  assert.ok(res.key.startsWith("skdev-"));
  assert.ok(res.keyId.startsWith("dkey_"));
  assert.equal(res.tier, "free");
  assert.match(res.masked, /\*\*\*\*/);
});

test("developer-keys: listDeveloperKeys returns masked keys and never raw material", async () => {
  const dev = await freshDeveloper("list@example.com");
  const a = await createDeveloperKey(dev, "A");
  const b = await createDeveloperKey(dev, "B");
  const res = await listDeveloperKeys(dev);
  assert.equal(res.ok, true);
  assert.equal(res.keys.length, 2);
  for (const k of res.keys) {
    assert.ok(!("key" in k));
    assert.ok(!("keyHash" in k));
    assert.ok(k.masked);
  }
  assert.deepEqual(
    res.keys.map((k) => k.keyId).sort(),
    [a.keyId, b.keyId].sort(),
  );
});

test("developer-keys: revokeDeveloperKey marks key as revoked", async () => {
  const dev = await freshDeveloper("revoke@example.com");
  const created = await createDeveloperKey(dev, "Temp");
  const rev = await revokeDeveloperKey(dev, created.keyId);
  assert.equal(rev.ok, true);
  const list = await listDeveloperKeys(dev);
  const key = list.keys.find((k) => k.keyId === created.keyId);
  assert.ok(key.revokedAt);
  // Raw key should no longer resolve to the developer.
  const lookup = await findDeveloperByRawKey(created.key);
  assert.equal(lookup, null);
});

test("developer-keys: enforces max keys per developer for free tier (3)", async () => {
  const dev = await freshDeveloper("maxkeys@example.com");
  for (let i = 0; i < 3; i++) {
    const ok = await createDeveloperKey(dev, `key-${i}`);
    assert.equal(ok.ok, true, `key ${i} should succeed`);
  }
  const over = await createDeveloperKey(dev, "key-4");
  assert.equal(over.ok, false);
  assert.match(over.error, /limit reached/i);
});

test("developer-keys: revoked keys free up slots for new key creation", async () => {
  const dev = await freshDeveloper("reuse@example.com");
  const keys = [];
  for (let i = 0; i < 3; i++) {
    keys.push(await createDeveloperKey(dev, `key-${i}`));
  }
  // Revoke one and create a new one.
  await revokeDeveloperKey(dev, keys[0].keyId);
  const fresh = await createDeveloperKey(dev, "replacement");
  assert.equal(fresh.ok, true);
});

test("developer-keys: checkDeveloperLimits allows within limits", async () => {
  const dev = await freshDeveloper("limits@example.com");
  const created = await createDeveloperKey(dev, "L");
  const res = await checkDeveloperLimits(created.keyId);
  assert.equal(res.allowed, true);
  assert.equal(res.tier, "free");
  assert.equal(res.remaining, DEVELOPER_TIERS.free.monthlyRequests);
});

test("developer-keys: checkDeveloperLimits denies revoked key", async () => {
  const dev = await freshDeveloper("revoked-check@example.com");
  const created = await createDeveloperKey(dev, "R");
  await revokeDeveloperKey(dev, created.keyId);
  const res = await checkDeveloperLimits(created.keyId);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /revoked/i);
});

test("developer-keys: recordDeveloperRequest increments monthly usage", async () => {
  const dev = await freshDeveloper("usage@example.com");
  const created = await createDeveloperKey(dev, "U");
  const first = await recordDeveloperRequest(created.keyId);
  assert.equal(first.ok, true);
  assert.equal(first.monthTotal, 1);
  await recordDeveloperRequest(created.keyId);
  await recordDeveloperRequest(created.keyId);
  const usage = await getDeveloperUsage(dev);
  assert.equal(usage.ok, true);
  assert.equal(usage.currentMonth.requests, 3);
  assert.equal(usage.byKey[created.keyId], 3);
  assert.equal(
    usage.currentMonth.remaining,
    DEVELOPER_TIERS.free.monthlyRequests - 3,
  );
});

test("developer-keys: rate limit denies after rateLimitPerMinute hits", async () => {
  const dev = await freshDeveloper("rate@example.com");
  const created = await createDeveloperKey(dev, "RL");
  // Fill the minute bucket up to the limit.
  for (let i = 0; i < DEVELOPER_TIERS.free.rateLimitPerMinute; i++) {
    await recordDeveloperRequest(created.keyId);
  }
  const res = await checkDeveloperLimits(created.keyId);
  assert.equal(res.allowed, false);
  assert.match(res.reason, /rate/i);
});

test("developer-keys: upgradeDeveloperTier changes tier and limits", async () => {
  const dev = await freshDeveloper("upgrade@example.com");
  const res = await upgradeDeveloperTier(dev, "pro");
  assert.equal(res.ok, true);
  assert.equal(res.previousTier, "free");
  assert.equal(res.tier, "pro");
  const profile = await getDeveloper(dev);
  assert.equal(profile.tier, "pro");
  // After upgrade, new keys allow more monthly requests.
  const key = await createDeveloperKey(dev, "post-upgrade");
  const check = await checkDeveloperLimits(key.keyId);
  assert.equal(check.tier, "pro");
  assert.equal(check.remaining, DEVELOPER_TIERS.pro.monthlyRequests);
});

test("developer-keys: upgradeDeveloperTier rejects invalid tier", async () => {
  const dev = await freshDeveloper("bad-upgrade@example.com");
  const res = await upgradeDeveloperTier(dev, "platinum");
  assert.equal(res.ok, false);
});

test("developer-keys: findDeveloperByRawKey returns tier scopes and features", async () => {
  const dev = await freshDeveloper("lookup@example.com");
  await upgradeDeveloperTier(dev, "pro");
  const key = await createDeveloperKey(dev, "lookup");
  const info = await findDeveloperByRawKey(key.key);
  assert.ok(info);
  assert.equal(info.developerId, dev);
  assert.equal(info.tier, "pro");
  assert.deepEqual(info.scopes, DEVELOPER_TIERS.pro.scopes);
});

test("developer-keys: findDeveloperByRawKey returns null for unknown keys", async () => {
  assert.equal(await findDeveloperByRawKey("skdev-unknown"), null);
  assert.equal(await findDeveloperByRawKey("sk-notadev"), null);
  assert.equal(await findDeveloperByRawKey(""), null);
  assert.equal(await findDeveloperByRawKey(null), null);
});
