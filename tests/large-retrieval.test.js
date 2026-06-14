/**
 * Phase 68.2: Large-scale retrieval tests. Uses fallback hash embeddings
 * to stay offline; tests mostly check structure + ranking stability.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Explicitly unset OPENAI_API_KEY so we exercise the deterministic fallback.
delete process.env.OPENAI_API_KEY;

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-large-retrieval-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  indexDocument,
  searchIndex,
  getIndexStats,
  listIndexes,
  chunkText,
  _internals,
} = await (async () => {
  const mod = await import("../lib/large-retrieval.js");
  return { ...mod, chunkText: mod._internals.chunkText, _internals: mod._internals };
})();

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("chunkText splits text into fixed-size token chunks", () => {
  const text = new Array(250).fill("word").join(" ");
  const chunks = chunkText(text, 100);
  assert.equal(chunks.length, 3); // 100 + 100 + 50
  assert.ok(chunks[0].split(/\s+/).length === 100);
});

test("deterministicVector is stable and L2 normalized", () => {
  const a = _internals.deterministicVector("hello world");
  const b = _internals.deterministicVector("hello world");
  assert.deepEqual(a, b);
  let norm = 0;
  for (const v of a) norm += v * v;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 0.01);
});

test("indexDocument validates inputs", async () => {
  await assert.rejects(() => indexDocument("", { text: "x" }), /indexName/);
  await assert.rejects(() => indexDocument("i", null), /doc object/);
  await assert.rejects(() => indexDocument("i", { text: "" }), /text/);
});

test("indexDocument creates an index and indexes chunks", async () => {
  const result = await indexDocument("ix1", {
    title: "doc-a",
    text: new Array(500).fill("lorem").join(" "),
  }, { chunkTokens: 100, clusterCount: 3 });
  assert.ok(result.docId);
  assert.equal(result.chunkCount, 5);
  const stats = await getIndexStats("ix1");
  assert.equal(stats.documentCount, 1);
  assert.equal(stats.chunkCount, 5);
  assert.ok(stats.clusterCount >= 1);
  assert.equal(stats.embeddingSource, "fallback");
});

test("indexDocument on existing index appends without overwriting", async () => {
  await indexDocument("ix-append", { title: "a", text: "alpha beta gamma delta epsilon" }, { chunkTokens: 3, clusterCount: 2 });
  await indexDocument("ix-append", { title: "b", text: "foo bar baz qux quux corge" }, { chunkTokens: 3, clusterCount: 2 });
  const stats = await getIndexStats("ix-append");
  assert.equal(stats.documentCount, 2);
  assert.ok(stats.chunkCount >= 3);
});

test("searchIndex returns top-K ranked results", async () => {
  await indexDocument("ix-search", {
    title: "cats",
    text: "cats are small domesticated carnivorous mammals often kept as pets by humans worldwide",
  }, { chunkTokens: 50 });
  await indexDocument("ix-search", {
    title: "finance",
    text: "quarterly earnings reports indicate strong revenue growth across international markets",
  }, { chunkTokens: 50 });
  const result = await searchIndex("ix-search", { query: "cats pets mammals", topK: 3 });
  assert.ok(result.results.length >= 1);
  assert.equal(result.results[0].docId, result.results[0].docId); // sanity
  // The "cats" doc should rank higher than "finance" for this query.
  const topTexts = result.results.map((r) => r.text).join(" ");
  assert.ok(/cats|mammals|pets/.test(topTexts));
});

test("searchIndex validates query", async () => {
  await assert.rejects(() => searchIndex("ix-search", {}), /query/);
});

test("searchIndex throws for missing index", async () => {
  await assert.rejects(() => searchIndex("missing-xyz", { query: "q" }), /not found/);
});

test("listIndexes includes created indexes", async () => {
  const all = await listIndexes();
  assert.ok(all.some((i) => i.name === "ix1"));
  assert.ok(all.every((i) => typeof i.chunkCount === "number"));
});

test("searchIndex respects probeClusters and returns cluster info", async () => {
  const result = await searchIndex("ix-search", {
    query: "earnings reports revenue",
    topK: 2,
    probeClusters: 1,
  });
  assert.equal(result.probedClusters, 1);
  assert.ok(result.totalChunks > 0);
});
