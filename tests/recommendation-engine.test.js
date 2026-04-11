/**
 * Phase 69.3: Recommendation engine tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-rec-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerItem,
  recordInteraction,
  recommend,
  listItems,
  getItemStats,
} = await import("../lib/recommendation-engine.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("registerItem persists items", async () => {
  const rec = await registerItem({ id: "i1", title: "Alpha", tags: ["news", "sports"], kind: "doc" });
  assert.equal(rec.id, "i1");
  assert.deepEqual(rec.tags, ["news", "sports"]);
});

test("registerItem rejects invalid input", async () => {
  await assert.rejects(() => registerItem(null));
  await assert.rejects(() => registerItem({}));
});

test("recordInteraction validates input", async () => {
  await assert.rejects(() => recordInteraction("", "x"));
  await assert.rejects(() => recordInteraction("u", ""));
});

test("recordInteraction accumulates scores by kind", async () => {
  await registerItem({ id: "rec1", tags: ["x"] });
  await recordInteraction("u1", "rec1", { kind: "view" });
  await recordInteraction("u1", "rec1", { kind: "like" });
  const stats = await getItemStats("rec1");
  assert.equal(stats.views, 1);
  assert.equal(stats.likes, 1);
  assert.ok(stats.totalScore > 0);
});

test("recommend returns content-based suggestions", async () => {
  await registerItem({ id: "c1", tags: ["cooking", "italian"] });
  await registerItem({ id: "c2", tags: ["cooking", "french"] });
  await registerItem({ id: "c3", tags: ["travel"] });
  await recordInteraction("chef", "c1", { kind: "like" });
  const recs = await recommend("chef");
  const ids = recs.map((r) => r.itemId);
  assert.ok(ids.includes("c2"));
  assert.ok(!ids.includes("c1")); // excludeSeen default
});

test("recommend uses collaborative filter", async () => {
  await registerItem({ id: "m1", tags: ["a"] });
  await registerItem({ id: "m2", tags: ["b"] });
  await registerItem({ id: "m3", tags: ["c"] });
  // Both users liked m1 and m2; peer also likes m3.
  await recordInteraction("alice", "m1", { kind: "like" });
  await recordInteraction("alice", "m2", { kind: "like" });
  await recordInteraction("bob", "m1", { kind: "like" });
  await recordInteraction("bob", "m2", { kind: "like" });
  await recordInteraction("bob", "m3", { kind: "like" });
  const recs = await recommend("alice");
  const ids = recs.map((r) => r.itemId);
  assert.ok(ids.includes("m3"));
});

test("recommend respects k limit", async () => {
  await registerItem({ id: "k1", tags: ["t"] });
  await registerItem({ id: "k2", tags: ["t"] });
  await registerItem({ id: "k3", tags: ["t"] });
  await registerItem({ id: "k_seed", tags: ["t"] });
  await recordInteraction("kuser", "k_seed", { kind: "like" });
  const recs = await recommend("kuser", { k: 2 });
  assert.ok(recs.length <= 2);
});

test("recommend returns empty if user has no interactions", async () => {
  const recs = await recommend("stranger");
  assert.deepEqual(recs, []);
});

test("recommend validates input", async () => {
  await assert.rejects(() => recommend(""));
});

test("listItems returns all catalog entries", async () => {
  await registerItem({ id: "list1" });
  const all = await listItems();
  assert.ok(all.length >= 1);
});

test("getItemStats returns null for missing items", async () => {
  assert.equal(await getItemStats("nope"), null);
  assert.equal(await getItemStats(""), null);
});
