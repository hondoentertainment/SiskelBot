/**
 * Phase 56.5: Reward model tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-reward-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  collectPreference,
  trainRewardModel,
  predictReward,
  exportModel,
  importModel,
  clearPreferences,
  countPreferences,
  featurize,
  _invalidateCache,
} = await import("../lib/reward-model.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("featurize produces unit-norm bias-prefixed vector", () => {
  const v = featurize("hello world foo", 64);
  assert.equal(v.length, 64);
  assert.ok(v[0] > 0, "bias index should be active");
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test("featurize is deterministic across calls", () => {
  const a = featurize("the cat sat", 32);
  const b = featurize("the cat sat", 32);
  assert.deepEqual(a, b);
});

test("collectPreference persists pairs and enforces text", async () => {
  await clearPreferences();
  const rec = await collectPreference({
    chosen: "This answer is clear and correct.",
    rejected: "garbage response nonsense",
    rater: "alice",
  });
  assert.ok(rec.id.startsWith("pref_"));
  assert.equal(rec.rater, "alice");
  await assert.rejects(() => collectPreference({ chosen: "", rejected: "x" }), /required/);
  await assert.rejects(() => collectPreference(null), /required/);
  const n = await countPreferences();
  assert.equal(n, 1);
});

test("trainRewardModel errors when there are no preferences", async () => {
  await clearPreferences();
  await assert.rejects(() => trainRewardModel(), /no preferences/);
});

test("trainRewardModel converges to high pairwise accuracy on separable data", async () => {
  await clearPreferences();
  // Synthetic clearly-separable data: "good" preferred over "bad".
  const goodWords = ["helpful", "clear", "accurate", "concise", "friendly"];
  const badWords = ["rude", "wrong", "incoherent", "nasty", "garbage"];
  for (let i = 0; i < 40; i++) {
    const g = goodWords[i % goodWords.length];
    const b = badWords[i % badWords.length];
    await collectPreference({
      chosen: `${g} ${g} ${g} response from assistant`,
      rejected: `${b} ${b} ${b} response from assistant`,
    });
  }
  const model = await trainRewardModel({ epochs: 30, lr: 0.2, dim: 128 });
  assert.ok(model.accuracy >= 0.9);
  assert.equal(model.dim, 128);
  assert.equal(model.preferenceCount, 40);
  assert.ok(model.lossHistory.length === 30);
});

test("predictReward ranks preferred-style text higher", async () => {
  _invalidateCache();
  const good = await predictReward("helpful clear accurate");
  const bad = await predictReward("rude wrong nasty");
  assert.ok(good > bad);
});

test("predictReward returns 0 for empty/unknown and when no model", async () => {
  assert.equal(await predictReward(""), 0);
  assert.equal(await predictReward(null), 0);
});

test("exportModel / importModel round-trip and preserve inference", async () => {
  const exported = await exportModel();
  assert.ok(Array.isArray(exported.weights));
  assert.equal(exported.dim, exported.weights.length);
  const before = await predictReward("helpful clear accurate");
  await clearPreferences();
  _invalidateCache();
  await importModel(exported);
  const after = await predictReward("helpful clear accurate");
  assert.equal(before, after);
});

test("importModel validates shape", async () => {
  await assert.rejects(() => importModel(null), /required/);
  await assert.rejects(() => importModel({ weights: [1, 2], dim: 4 }), /dim must match/);
  await assert.rejects(() => importModel({ dim: 2 }), /weights required/);
});

test("exportModel errors when no model trained", async () => {
  await clearPreferences();
  _invalidateCache();
  await assert.rejects(() => exportModel(), /no trained model/);
});
