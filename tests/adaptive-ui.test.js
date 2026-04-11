/**
 * Phase 69.2: Adaptive UI tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-aui-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordFeatureUse,
  getSurfacedFeatures,
  rankFeatures,
  resetUsage,
  listUsers,
} = await import("../lib/adaptive-ui.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("recordFeatureUse increments usage counters", async () => {
  const r = await recordFeatureUse("u1", "feat.a");
  assert.equal(r.uses, 1);
  const r2 = await recordFeatureUse("u1", "feat.a");
  assert.equal(r2.uses, 2);
  assert.ok(r2.lastUsedAt);
});

test("recordFeatureUse validates input", async () => {
  await assert.rejects(() => recordFeatureUse("", "x"));
  await assert.rejects(() => recordFeatureUse("u", ""));
});

test("rankFeatures orders by blended score", () => {
  const now = Date.now();
  const features = {
    fresh: { uses: 2, lastUsedAt: new Date(now).toISOString() },
    stale: { uses: 10, lastUsedAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() },
    mid: { uses: 5, lastUsedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString() },
  };
  const ranked = rankFeatures(features, now);
  assert.equal(ranked.length, 3);
  // Fresh (2*1.0=2) < mid (5*~0.83=4.15) -> mid first
  assert.equal(ranked[0].featureId, "mid");
  // Stale boost is 0.1, so stale * 10 = 1
  assert.ok(ranked.findIndex((r) => r.featureId === "stale") >= 0);
});

test("rankFeatures handles empty / invalid input", () => {
  assert.deepEqual(rankFeatures(null), []);
  assert.deepEqual(rankFeatures({}), []);
});

test("getSurfacedFeatures returns top-N for a user", async () => {
  await recordFeatureUse("u2", "x");
  await recordFeatureUse("u2", "y");
  await recordFeatureUse("u2", "z");
  await recordFeatureUse("u2", "y");
  const features = await getSurfacedFeatures("u2", { limit: 2 });
  assert.equal(features.length, 2);
  assert.equal(features[0].featureId, "y");
});

test("getSurfacedFeatures returns [] for unknown users", async () => {
  const f = await getSurfacedFeatures("ghost");
  assert.deepEqual(f, []);
});

test("getSurfacedFeatures hideThreshold filters low scores", async () => {
  await recordFeatureUse("u3", "low");
  const f = await getSurfacedFeatures("u3", { hideThreshold: 1000 });
  assert.equal(f.length, 0);
});

test("resetUsage clears all features for a user", async () => {
  await recordFeatureUse("u4", "a");
  await recordFeatureUse("u4", "b");
  const r = await resetUsage("u4");
  assert.equal(r.cleared, 2);
  const f = await getSurfacedFeatures("u4");
  assert.equal(f.length, 0);
});

test("resetUsage clears a single feature when specified", async () => {
  await recordFeatureUse("u5", "keep");
  await recordFeatureUse("u5", "drop");
  const r = await resetUsage("u5", { featureId: "drop" });
  assert.equal(r.cleared, 1);
  const f = await getSurfacedFeatures("u5");
  assert.ok(f.some((x) => x.featureId === "keep"));
  assert.ok(!f.some((x) => x.featureId === "drop"));
});

test("listUsers returns every tracked user id", async () => {
  await recordFeatureUse("alice", "f");
  await recordFeatureUse("bob", "f");
  const users = await listUsers();
  assert.ok(users.includes("alice"));
  assert.ok(users.includes("bob"));
});
