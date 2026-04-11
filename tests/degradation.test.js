/**
 * Phase 59.3: Degradation tiers tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-degrade-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  setTier,
  getTier,
  isFeatureEnabled,
  registerFeature,
  listFeatures,
  getTierHistory,
} = await import("../lib/degradation.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("getTier defaults to P2", async () => {
  const tier = await getTier();
  assert.equal(tier, "P2");
});

test("setTier persists and appends history", async () => {
  const result = await setTier("P1", { reason: "brownout", actor: "admin" });
  assert.equal(result.tier, "P1");
  const history = await getTierHistory();
  assert.ok(history.length >= 1);
  assert.equal(history[history.length - 1].to, "P1");
});

test("setTier rejects invalid tier", async () => {
  await assert.rejects(() => setTier("P5"));
  await assert.rejects(() => setTier(""));
});

test("registerFeature stores a feature definition", async () => {
  const f = await registerFeature({
    name: "chat-streaming",
    tier: "P2",
    description: "SSE chat completions",
  });
  assert.equal(f.name, "chat-streaming");
  assert.equal(f.tier, "P2");
  assert.ok(f.createdAt);
});

test("registerFeature rejects missing fields", async () => {
  await assert.rejects(() => registerFeature(null));
  await assert.rejects(() => registerFeature({ name: "x", tier: "invalid" }));
  await assert.rejects(() => registerFeature({ tier: "P0" }));
});

test("isFeatureEnabled respects tier hierarchy", async () => {
  await registerFeature({ name: "core-api", tier: "P0" });
  await registerFeature({ name: "search", tier: "P1" });
  await registerFeature({ name: "streaming", tier: "P2" });

  await setTier("P2");
  assert.equal(await isFeatureEnabled("core-api"), true);
  assert.equal(await isFeatureEnabled("search"), true);
  assert.equal(await isFeatureEnabled("streaming"), true);

  await setTier("P1");
  assert.equal(await isFeatureEnabled("streaming"), false);
  assert.equal(await isFeatureEnabled("search"), true);
  assert.equal(await isFeatureEnabled("core-api"), true);

  await setTier("P0");
  assert.equal(await isFeatureEnabled("streaming"), false);
  assert.equal(await isFeatureEnabled("search"), false);
  assert.equal(await isFeatureEnabled("core-api"), true);
});

test("isFeatureEnabled returns false for unknown features", async () => {
  assert.equal(await isFeatureEnabled("nope"), false);
  assert.equal(await isFeatureEnabled(""), false);
});

test("manual enabled=false override disables feature regardless of tier", async () => {
  await registerFeature({ name: "force-off", tier: "P0", enabled: false });
  await setTier("P2");
  assert.equal(await isFeatureEnabled("force-off"), false);
});

test("manual enabled=true override keeps feature on under brownout", async () => {
  await registerFeature({ name: "force-on", tier: "P2", enabled: true });
  await setTier("P0");
  assert.equal(await isFeatureEnabled("force-on"), true);
});

test("listFeatures includes effective flag for each feature", async () => {
  await setTier("P1");
  const features = await listFeatures();
  assert.ok(features.length >= 4);
  for (const f of features) {
    assert.equal(typeof f.effective, "boolean");
  }
  const core = features.find((f) => f.name === "core-api");
  assert.equal(core.effective, true);
});
