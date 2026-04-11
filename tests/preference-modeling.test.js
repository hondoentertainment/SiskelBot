/**
 * Phase 69.1: Preference modeling tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-pref-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  recordPreference,
  getUserProfile,
  updateProfile,
  listPreferences,
  mergePreferences,
} = await import("../lib/preference-modeling.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("recordPreference accumulates implicit weights", async () => {
  await recordPreference("u1", { type: "implicit", key: "topic.food", weight: 2 });
  await recordPreference("u1", { type: "implicit", key: "topic.food", weight: 1 });
  const p = await getUserProfile("u1");
  assert.equal(p.implicit["topic.food"].weight, 3);
  assert.equal(p.implicit["topic.food"].count, 2);
});

test("recordPreference stores explicit values", async () => {
  await recordPreference("u2", { type: "explicit", key: "theme", value: "dark" });
  const p = await getUserProfile("u2");
  assert.equal(p.explicit.theme.value, "dark");
});

test("recordPreference validates input", async () => {
  await assert.rejects(() => recordPreference("", { type: "implicit", key: "x" }));
  await assert.rejects(() => recordPreference("u", null));
  await assert.rejects(() => recordPreference("u", { type: "implicit", key: "" }));
  await assert.rejects(() => recordPreference("u", { type: "bogus", key: "x" }));
});

test("getUserProfile returns empty for unknown users", async () => {
  const p = await getUserProfile("ghost");
  assert.equal(p.userId, "ghost");
  assert.deepEqual(p.implicit, {});
  assert.deepEqual(p.explicit, {});
});

test("updateProfile merges explicit values", async () => {
  await updateProfile("u3", { explicit: { lang: "en", color: "blue" } });
  const p = await getUserProfile("u3");
  assert.equal(p.explicit.lang.value, "en");
  assert.equal(p.explicit.color.value, "blue");
});

test("updateProfile replace:true wipes existing explicit values", async () => {
  await updateProfile("u4", { explicit: { a: 1, b: 2 } });
  await updateProfile("u4", { explicit: { c: 3 }, replace: true });
  const p = await getUserProfile("u4");
  assert.equal(p.explicit.c.value, 3);
  assert.equal(p.explicit.a, undefined);
  assert.equal(p.explicit.b, undefined);
});

test("updateProfile validates input", async () => {
  await assert.rejects(() => updateProfile("", {}));
  await assert.rejects(() => updateProfile("u", null));
});

test("listPreferences ranks by weight descending", async () => {
  await recordPreference("u5", { type: "implicit", key: "a", weight: 1 });
  await recordPreference("u5", { type: "implicit", key: "b", weight: 5 });
  await recordPreference("u5", { type: "implicit", key: "c", weight: 3 });
  const list = await listPreferences("u5");
  const keys = list.map((x) => x.key);
  assert.deepEqual(keys.slice(0, 3), ["b", "c", "a"]);
});

test("listPreferences respects limit", async () => {
  await recordPreference("u6", { type: "implicit", key: "x", weight: 1 });
  await recordPreference("u6", { type: "implicit", key: "y", weight: 1 });
  const list = await listPreferences("u6", { limit: 1 });
  assert.equal(list.length, 1);
});

test("mergePreferences sums implicit weights and preserves target explicit", async () => {
  await recordPreference("src", { type: "implicit", key: "k1", weight: 4 });
  await recordPreference("src", { type: "explicit", key: "theme", value: "light" });
  await recordPreference("tgt", { type: "implicit", key: "k1", weight: 2 });
  await recordPreference("tgt", { type: "explicit", key: "theme", value: "dark" });
  const merged = await mergePreferences("tgt", "src");
  assert.equal(merged.implicit.k1.weight, 6);
  // Target explicit wins.
  assert.equal(merged.explicit.theme.value, "dark");
});

test("mergePreferences validates arguments", async () => {
  await assert.rejects(() => mergePreferences("", "b"));
  await assert.rejects(() => mergePreferences("a", ""));
  await assert.rejects(() => mergePreferences("same", "same"));
});
