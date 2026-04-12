/**
 * Phase 59.3: Degradation tiers tests.
 *
 * Covers: TIERS / BROWNOUT_LEVELS exposure, feature CRUD, brown-out level
 * state, auto-adjust signals, availability checks, middleware, fallbacks,
 * history, and policy overrides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-degradation-tiers-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  TIERS,
  BROWNOUT_LEVELS,
  registerFeature,
  unregisterFeature,
  getFeature,
  listFeatures,
  updateFeatureTier,
  getBrownoutLevel,
  setBrownoutLevel,
  autoAdjustBrownoutLevel,
  isFeatureAvailable,
  getDisabledFeatures,
  featureGateMiddleware,
  registerFallback,
  getFallback,
  callWithFallback,
  recordBrownoutEvent,
  getBrownoutHistory,
  getFeatureUsageStats,
  setPolicyOverride,
  clearPolicyOverride,
  _resetInMemoryState,
} = await import("../lib/degradation-tiers.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

async function reset() {
  _resetInMemoryState();
  await setBrownoutLevel("green", "reset");
  const features = await listFeatures();
  for (const f of features) await unregisterFeature(f.name);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test("TIERS and BROWNOUT_LEVELS are exposed with expected shape", () => {
  assert.ok(TIERS.P0 && TIERS.P1 && TIERS.P2 && TIERS.P3);
  assert.equal(TIERS.P0.name, "Essential");
  assert.equal(TIERS.P3.name, "Luxury");
  assert.ok(Array.isArray(BROWNOUT_LEVELS.green.disabledTiers));
  assert.deepEqual(BROWNOUT_LEVELS.green.disabledTiers, []);
  assert.deepEqual(BROWNOUT_LEVELS.yellow.disabledTiers, ["P3"]);
  assert.deepEqual(BROWNOUT_LEVELS.orange.disabledTiers, ["P2", "P3"]);
  assert.deepEqual(BROWNOUT_LEVELS.red.disabledTiers, ["P1", "P2", "P3"]);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test("registerFeature persists and getFeature returns the entry", async () => {
  await reset();
  const entry = await registerFeature("search", "P1", { owner: "platform" });
  assert.equal(entry.name, "search");
  assert.equal(entry.tier, "P1");
  assert.equal(entry.metadata.owner, "platform");
  const fetched = await getFeature("search");
  assert.equal(fetched.tier, "P1");
});

test("listFeatures supports tier filter", async () => {
  await reset();
  await registerFeature("chat", "P0");
  await registerFeature("search", "P1");
  await registerFeature("recs", "P3");
  const p1 = await listFeatures({ tier: "P1" });
  assert.equal(p1.length, 1);
  assert.equal(p1[0].name, "search");
  const all = await listFeatures();
  assert.equal(all.length, 3);
});

test("updateFeatureTier changes the tier", async () => {
  await reset();
  await registerFeature("recs", "P3");
  const updated = await updateFeatureTier("recs", "P2");
  assert.equal(updated.tier, "P2");
  const again = await getFeature("recs");
  assert.equal(again.tier, "P2");
});

// ---------------------------------------------------------------------------
// Brown-out state
// ---------------------------------------------------------------------------

test("getBrownoutLevel default is green", async () => {
  await reset();
  const state = await getBrownoutLevel();
  assert.equal(state.level, "green");
});

test("setBrownoutLevel persists", async () => {
  await reset();
  await setBrownoutLevel("orange", "cpu high");
  const state = await getBrownoutLevel();
  assert.equal(state.level, "orange");
  assert.equal(state.reason, "cpu high");
});

test("autoAdjustBrownoutLevel picks the correct level from signals", async () => {
  await reset();
  await autoAdjustBrownoutLevel({ cpu: 0.1, memory: 0.1, errorRate: 0 });
  assert.equal((await getBrownoutLevel()).level, "green");

  await autoAdjustBrownoutLevel({ cpu: 0.75, memory: 0.3, errorRate: 0 });
  assert.equal((await getBrownoutLevel()).level, "yellow");

  await autoAdjustBrownoutLevel({ cpu: 0.2, memory: 0.2, errorRate: 0.12 });
  assert.equal((await getBrownoutLevel()).level, "orange");

  await autoAdjustBrownoutLevel({ cpu: 0.2, memory: 0.98, errorRate: 0 });
  assert.equal((await getBrownoutLevel()).level, "red");
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

test("isFeatureAvailable: P0 is always available", async () => {
  await reset();
  await registerFeature("core", "P0");
  await setBrownoutLevel("red");
  assert.equal(await isFeatureAvailable("core"), true);
});

test("isFeatureAvailable: P3 blocked at orange", async () => {
  await reset();
  await registerFeature("recs", "P3");
  await setBrownoutLevel("orange");
  assert.equal(await isFeatureAvailable("recs"), false);
  await setBrownoutLevel("green");
  assert.equal(await isFeatureAvailable("recs"), true);
});

test("getDisabledFeatures returns every disabled feature at red", async () => {
  await reset();
  await registerFeature("core", "P0");
  await registerFeature("imp", "P1");
  await registerFeature("nice", "P2");
  await registerFeature("lux", "P3");
  await setBrownoutLevel("red");
  const disabled = await getDisabledFeatures();
  const names = disabled.map((f) => f.name).sort();
  assert.deepEqual(names, ["imp", "lux", "nice"]);
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

test("featureGateMiddleware allows requests when the feature is available", async () => {
  await reset();
  await registerFeature("chat", "P0");
  const mw = featureGateMiddleware("chat");
  let called = false;
  const next = (err) => {
    if (err) throw err;
    called = true;
  };
  await mw({}, fakeRes(), next);
  assert.equal(called, true);
});

test("featureGateMiddleware blocks requests with 503 when the feature is disabled", async () => {
  await reset();
  await registerFeature("recs", "P3");
  await setBrownoutLevel("yellow");
  const mw = featureGateMiddleware("recs");
  const res = fakeRes();
  let nextCalled = false;
  await mw({}, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, "FEATURE_DEGRADED");
  assert.equal(res.body.feature, "recs");
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

test("registerFallback stores the function and getFallback retrieves it", async () => {
  await reset();
  const fn = async (x) => `fallback(${x})`;
  await registerFallback("search", fn);
  const fetched = await getFallback("search");
  assert.equal(fetched, fn);
});

test("callWithFallback uses the primary when the feature is available", async () => {
  await reset();
  await registerFeature("search", "P2");
  await registerFallback("search", async () => "FALLBACK");
  await setBrownoutLevel("green");
  const out = await callWithFallback("search", async (q) => `primary:${q}`, ["hello"]);
  assert.equal(out, "primary:hello");
});

test("callWithFallback uses the fallback when the feature is disabled", async () => {
  await reset();
  await registerFeature("search", "P2");
  await registerFallback("search", async (q) => `fallback:${q}`);
  await setBrownoutLevel("orange");
  const out = await callWithFallback("search", async (q) => `primary:${q}`, ["hello"]);
  assert.equal(out, "fallback:hello");
});

test("callWithFallback throws when disabled and no fallback is registered", async () => {
  await reset();
  await registerFeature("search", "P2");
  await setBrownoutLevel("orange");
  await assert.rejects(() => callWithFallback("search", async () => "primary"), /degraded/i);
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test("recordBrownoutEvent appends to history", async () => {
  await reset();
  await recordBrownoutEvent({ type: "custom", message: "manual drill" });
  const history = await getBrownoutHistory();
  const match = history.find((e) => e.type === "custom" && e.message === "manual drill");
  assert.ok(match, "custom event should be present in history");
});

test("getBrownoutHistory filters by since/until/limit", async () => {
  await reset();
  await recordBrownoutEvent({ type: "a" });
  await recordBrownoutEvent({ type: "b" });
  await recordBrownoutEvent({ type: "c" });
  const limited = await getBrownoutHistory({ limit: 2 });
  assert.equal(limited.length, 2);
  const since = await getBrownoutHistory({ since: Date.now() + 60_000 });
  assert.equal(since.length, 0);
});

// ---------------------------------------------------------------------------
// Policy overrides
// ---------------------------------------------------------------------------

test("setPolicyOverride with forceEnabled bypasses tier checks", async () => {
  await reset();
  await registerFeature("recs", "P3");
  await setBrownoutLevel("red");
  assert.equal(await isFeatureAvailable("recs"), false);
  await setPolicyOverride("recs", { forceEnabled: true, reason: "VIP customer demo" });
  assert.equal(await isFeatureAvailable("recs"), true);
  await clearPolicyOverride("recs");
  assert.equal(await isFeatureAvailable("recs"), false);
});

test("setPolicyOverride with forceDisabled hides an otherwise-available feature", async () => {
  await reset();
  await registerFeature("chat", "P0");
  await setPolicyOverride("chat", { forceDisabled: true, reason: "maintenance" });
  assert.equal(await isFeatureAvailable("chat"), false);
  await clearPolicyOverride("chat");
  assert.equal(await isFeatureAvailable("chat"), true);
});

// ---------------------------------------------------------------------------
// Usage stats
// ---------------------------------------------------------------------------

test("getFeatureUsageStats reflects blocked + success counts", async () => {
  await reset();
  await registerFeature("search", "P2");
  await setBrownoutLevel("green");
  const mw = featureGateMiddleware("search");
  await mw({}, fakeRes(), () => {});
  await setBrownoutLevel("orange");
  await mw({}, fakeRes(), () => {});
  const stats = await getFeatureUsageStats("search");
  assert.ok(stats.attempts >= 2);
  assert.ok(stats.success >= 1);
  assert.ok(stats.blocked >= 1);
});
