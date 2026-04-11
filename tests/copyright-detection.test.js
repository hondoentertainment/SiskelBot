/**
 * Phase 67.2: Copyright detection tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-copyright-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  addCorpus,
  checkSimilarity,
  listCorpora,
  getMatches,
  removeCorpus,
  shingles,
  jaccard,
} = await import("../lib/copyright-detection.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("shingles produces n-gram strings", () => {
  const s = shingles("the quick brown fox jumps over the lazy dog", 3);
  assert.ok(s.has("the quick brown"));
  assert.ok(s.has("quick brown fox"));
  assert.ok(s.size >= 5);
});

test("shingles falls back to single tokens for short texts", () => {
  const s = shingles("hi there", 5);
  assert.ok(s.has("hi"));
  assert.ok(s.has("there"));
});

test("jaccard returns 1 for identical sets and 0 for disjoint sets", () => {
  const a = new Set(["x", "y", "z"]);
  const b = new Set(["x", "y", "z"]);
  const c = new Set(["a", "b", "c"]);
  assert.equal(jaccard(a, b), 1);
  assert.equal(jaccard(a, c), 0);
  assert.ok(jaccard(new Set(["x"]), new Set(["x", "y"])) > 0);
});

test("addCorpus validates required fields", async () => {
  await assert.rejects(() => addCorpus(null));
  await assert.rejects(() => addCorpus({ corpusId: "c" }));
  await assert.rejects(() => addCorpus({ corpusId: "c", title: "t" }));
  await assert.rejects(() => addCorpus({ corpusId: "c", title: "t", text: "   " }));
});

test("addCorpus stores an entry with computed shingles", async () => {
  const rec = await addCorpus({
    corpusId: "books",
    title: "Example Book",
    text: "The rain in Spain stays mainly in the plain and the wind blows from the north",
  });
  assert.ok(rec.id);
  assert.equal(rec.corpusId, "books");
  assert.ok(rec.shingleCount > 0);
});

test("checkSimilarity finds close matches above threshold", async () => {
  await addCorpus({
    corpusId: "docs",
    title: "Reference",
    text: "Alice opened the door and walked into the garden full of roses and tulips",
  });
  const result = await checkSimilarity({
    corpusId: "docs",
    text: "Alice opened the door and walked into the garden full of roses and tulips quietly",
    threshold: 0.3,
  });
  assert.ok(result.matches.length >= 1);
  assert.ok(result.matches[0].score >= 0.3);
});

test("checkSimilarity returns no matches when text is unrelated", async () => {
  await addCorpus({
    corpusId: "tech",
    title: "Doc A",
    text: "high performance computing cluster load balancer kubernetes docker",
  });
  const result = await checkSimilarity({
    corpusId: "tech",
    text: "a completely different story about elephants walking through savannah",
    threshold: 0.3,
  });
  assert.equal(result.matches.length, 0);
});

test("checkSimilarity supports corpus-less search across all", async () => {
  await addCorpus({ corpusId: "multi-a", title: "A", text: "xylophone zebra blizzard carpet chandelier" });
  await addCorpus({ corpusId: "multi-b", title: "B", text: "xylophone zebra blizzard carpet chandelier" });
  const result = await checkSimilarity({
    text: "xylophone zebra blizzard carpet chandelier",
    threshold: 0.5,
  });
  assert.ok(result.matches.length >= 2);
});

test("checkSimilarity persists matches when persist=true", async () => {
  await addCorpus({
    corpusId: "persist-corpus",
    title: "P",
    text: "persistent matches should be stored for audit and review pipeline use",
  });
  await checkSimilarity({
    corpusId: "persist-corpus",
    text: "persistent matches should be stored for audit and review pipeline use",
    threshold: 0.5,
    persist: true,
  });
  const stored = await getMatches({ limit: 5 });
  assert.ok(stored.length >= 1);
  assert.ok(stored[0].matches.length >= 1);
});

test("listCorpora returns entry counts per corpus", async () => {
  await addCorpus({ corpusId: "list1", title: "a", text: "one two three four five" });
  await addCorpus({ corpusId: "list1", title: "b", text: "six seven eight nine ten" });
  const corpora = await listCorpora();
  const list1 = corpora.find((c) => c.id === "list1");
  assert.ok(list1);
  assert.ok(list1.entries >= 2);
});

test("removeCorpus deletes whole corpus or single entry", async () => {
  const rec = await addCorpus({
    corpusId: "rm1",
    title: "entry",
    text: "will be deleted soon one two three four five",
  });
  const okOne = await removeCorpus({ corpusId: "rm1", entryId: rec.id });
  assert.equal(okOne, true);
  const okCorpus = await removeCorpus({ corpusId: "rm1" });
  assert.ok(typeof okCorpus === "boolean");
  const missing = await removeCorpus({ corpusId: "nope" });
  assert.equal(missing, false);
  await assert.rejects(() => removeCorpus(null));
});
