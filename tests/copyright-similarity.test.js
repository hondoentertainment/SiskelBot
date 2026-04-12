/**
 * Phase 67.2: Copyright similarity tests. All content is synthetic test data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-copyright-sim-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  tokenize,
  shingles,
  indexCorpus,
  listCorpora,
  getCorpus,
  deleteCorpus,
  findSimilar,
} = await import("../lib/copyright-similarity.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("tokenize lowercases and splits on non-alphanumerics", () => {
  assert.deepEqual(tokenize("Hello, World!"), ["hello", "world"]);
  assert.deepEqual(tokenize("foo_bar baz"), ["foo", "bar", "baz"]);
});

test("shingles produces overlapping k-grams", () => {
  const out = shingles("the quick brown fox jumps over the lazy dog", 3);
  assert.ok(out.length > 0);
  assert.equal(out[0], "the quick brown");
  assert.equal(out[1], "quick brown fox");
});

test("indexCorpus validates inputs", async () => {
  await assert.rejects(() => indexCorpus({}), /name/);
  await assert.rejects(() => indexCorpus({ name: "x" }), /items/);
  await assert.rejects(() => indexCorpus({ name: "x", items: [{ title: "t" }] }), /text/);
});

test("indexCorpus persists and getCorpus summarizes entries", async () => {
  const rec = await indexCorpus({
    name: "synthetic-books",
    items: [
      { title: "book-a", text: "sample text one about foxes jumping over fences" },
      { title: "book-b", text: "another document about turtles and rabbits in fields" },
    ],
    shingleSize: 3,
  });
  assert.ok(rec.id);
  assert.equal(rec.entries, 2);
  const fetched = await getCorpus(rec.id);
  assert.equal(fetched.entries.length, 2);
  assert.ok(fetched.entries[0].totalShingles > 0);
});

test("findSimilar detects near-duplicate text", async () => {
  const rec = await indexCorpus({
    name: "near-dup",
    items: [
      { title: "original", text: "the quick brown fox jumps over the lazy dog and then vanishes beyond the meadow" },
      { title: "different", text: "totally unrelated content about marine biology and coral reefs" },
    ],
    shingleSize: 3,
  });
  const result = await findSimilar(rec.id, {
    text: "the quick brown fox jumps over the lazy dog and then vanishes beyond",
    minScore: 0.1,
  });
  assert.ok(result.results.length >= 1);
  assert.equal(result.results[0].title, "original");
  assert.ok(result.results[0].score > 0.3);
});

test("findSimilar returns no matches for unrelated text", async () => {
  const rec = await indexCorpus({
    name: "no-match",
    items: [
      { title: "a", text: "financial statements for the fiscal quarter including expenses" },
    ],
    shingleSize: 3,
  });
  const result = await findSimilar(rec.id, {
    text: "rainbows sparkled across the ancient mountain ranges at dawn",
    minScore: 0.3,
  });
  assert.equal(result.results.length, 0);
});

test("findSimilar respects limit", async () => {
  const rec = await indexCorpus({
    name: "limit-test",
    items: [
      { title: "a", text: "alpha beta gamma delta epsilon zeta eta theta iota kappa" },
      { title: "b", text: "alpha beta gamma delta epsilon zeta eta lambda mu nu" },
      { title: "c", text: "alpha beta gamma delta zeta eta theta iota" },
    ],
    shingleSize: 3,
  });
  const result = await findSimilar(rec.id, {
    text: "alpha beta gamma delta epsilon zeta eta",
    minScore: 0.05,
    limit: 2,
  });
  assert.ok(result.results.length <= 2);
});

test("findSimilar throws on missing corpus", async () => {
  await assert.rejects(() => findSimilar("missing", { text: "abc" }), /not found/);
});

test("listCorpora includes newly created corpus", async () => {
  const rec = await indexCorpus({
    name: "listable",
    items: [{ title: "t", text: "some text here for listing tests" }],
    shingleSize: 3,
  });
  const list = await listCorpora();
  assert.ok(list.some((c) => c.id === rec.id));
});

test("deleteCorpus removes the record", async () => {
  const rec = await indexCorpus({
    name: "to-delete",
    items: [{ title: "x", text: "delete me please this is the corpus body" }],
    shingleSize: 3,
  });
  const del = await deleteCorpus(rec.id);
  assert.equal(del.ok, true);
  assert.equal(await getCorpus(rec.id), null);
});
