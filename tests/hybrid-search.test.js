import test from "node:test";
import assert from "node:assert/strict";
import { reciprocalRankFusion, hybridSearch } from "../lib/hybrid-search.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempDir = mkdtempSync(join(tmpdir(), "hybrid-search-test-"));

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// --- reciprocalRankFusion tests ---

await test("reciprocalRankFusion returns empty map for empty input", () => {
  const result = reciprocalRankFusion([]);
  assert.equal(result.size, 0);
});

await test("reciprocalRankFusion returns empty map for null rankings", () => {
  const result = reciprocalRankFusion([null, undefined]);
  assert.equal(result.size, 0);
});

await test("reciprocalRankFusion scores single ranking correctly", () => {
  const ranking = [
    { id: "doc1" },
    { id: "doc2" },
    { id: "doc3" },
  ];
  const scores = reciprocalRankFusion([ranking], 60);

  assert.ok(scores.has("doc1"));
  assert.ok(scores.has("doc2"));
  assert.ok(scores.has("doc3"));

  // doc1 is rank 0 (1-based rank 1): 1/(60+1) = 1/61
  assert.ok(Math.abs(scores.get("doc1") - 1 / 61) < 0.0001);
  // doc2 is rank 1 (1-based rank 2): 1/(60+2) = 1/62
  assert.ok(Math.abs(scores.get("doc2") - 1 / 62) < 0.0001);
  // doc3 is rank 2 (1-based rank 3): 1/(60+3) = 1/63
  assert.ok(Math.abs(scores.get("doc3") - 1 / 63) < 0.0001);
});

await test("reciprocalRankFusion fuses two rankings and boosts docs in both", () => {
  const kwRanking = [
    { id: "doc1" },
    { id: "doc2" },
    { id: "doc3" },
  ];
  const semRanking = [
    { id: "doc2" },
    { id: "doc3" },
    { id: "doc4" },
  ];
  const scores = reciprocalRankFusion([kwRanking, semRanking], 60);

  // doc2 appears in both: 1/62 (kw rank 2) + 1/61 (sem rank 1) = should be highest
  // doc3 appears in both: 1/63 (kw rank 3) + 1/62 (sem rank 2)
  // doc1 appears in kw only: 1/61
  // doc4 appears in sem only: 1/63

  assert.ok(scores.get("doc2") > scores.get("doc1"), "doc2 (in both) should outscore doc1 (kw only)");
  assert.ok(scores.get("doc2") > scores.get("doc4"), "doc2 (in both) should outscore doc4 (sem only)");
  assert.ok(scores.get("doc3") > scores.get("doc1"), "doc3 (in both) should outscore doc1 (kw only)");
  assert.ok(scores.get("doc3") > scores.get("doc4"), "doc3 (in both) should outscore doc4 (sem only)");
});

await test("reciprocalRankFusion respects k parameter", () => {
  const ranking = [{ id: "a" }, { id: "b" }];
  const scoresK1 = reciprocalRankFusion([ranking], 1);
  const scoresK100 = reciprocalRankFusion([ranking], 100);

  // With k=1: 1/(1+1)=0.5 vs 1/(1+2)=0.333
  // With k=100: 1/(100+1)=0.0099 vs 1/(100+2)=0.0098
  // Difference should be bigger with smaller k
  const diffK1 = scoresK1.get("a") - scoresK1.get("b");
  const diffK100 = scoresK100.get("a") - scoresK100.get("b");
  assert.ok(diffK1 > diffK100, "smaller k emphasizes top rank more");
});

await test("reciprocalRankFusion skips items without id", () => {
  const ranking = [{ id: "a" }, { noId: true }, { id: "b" }];
  const scores = reciprocalRankFusion([ranking]);
  assert.equal(scores.size, 2);
  assert.ok(scores.has("a"));
  assert.ok(scores.has("b"));
});

// --- hybridSearch integration tests ---

await test("hybridSearch returns empty results for empty query", async () => {
  const result = await hybridSearch("", "default", { dataDir: tempDir });
  assert.deepEqual(result.results, []);
});

await test("hybridSearch returns empty results for whitespace query", async () => {
  const result = await hybridSearch("   ", "default", { dataDir: tempDir });
  assert.deepEqual(result.results, []);
});

await test("hybridSearch keyword mode returns results with source=keyword", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");
  await indexDocument({ text: "Hybrid search keyword test content about Node.js", workspace: "hybridsearch", title: "KW Test", dataDir: tempDir });

  const result = await hybridSearch("Node.js", "hybridsearch", { mode: "keyword", dataDir: tempDir });
  assert.equal(result.mode, "keyword");
  assert.ok(Array.isArray(result.results));
  for (const r of result.results) {
    assert.equal(r.source, "keyword");
    assert.ok(r.docId);
    assert.ok(typeof r.score === "number");
  }
});

await test("hybridSearch semantic mode returns results with source=semantic", async () => {
  // Without OPENAI_API_KEY, semantic search returns empty or error
  const result = await hybridSearch("Node.js", "hybridsearch", { mode: "semantic", dataDir: tempDir });
  assert.equal(result.mode, "semantic");
  assert.ok(Array.isArray(result.results));
  // All results (if any) should have source=semantic
  for (const r of result.results) {
    assert.equal(r.source, "semantic");
  }
});

await test("hybridSearch hybrid mode sets correct mode", async () => {
  const result = await hybridSearch("Node.js", "hybridsearch", { mode: "hybrid", dataDir: tempDir });
  assert.equal(result.mode, "hybrid");
  assert.ok(Array.isArray(result.results));
});

await test("hybridSearch defaults to hybrid mode", async () => {
  const result = await hybridSearch("test", "hybridsearch", { dataDir: tempDir });
  assert.equal(result.mode, "hybrid");
});

await test("hybridSearch respects limit option", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");
  for (let i = 0; i < 5; i++) {
    await indexDocument({ text: `Limit test document number ${i} with unique content xyz`, workspace: "limitws", title: `LimitDoc${i}`, dataDir: tempDir });
  }

  const result = await hybridSearch("unique content xyz", "limitws", { mode: "keyword", limit: 2, dataDir: tempDir });
  assert.ok(result.results.length <= 2);
});

await test("hybridSearch result objects have expected fields", async () => {
  const result = await hybridSearch("Node.js", "hybridsearch", { mode: "keyword", dataDir: tempDir });
  if (result.results.length > 0) {
    const r = result.results[0];
    assert.ok("docId" in r);
    assert.ok("title" in r);
    assert.ok("snippet" in r);
    assert.ok("score" in r);
    assert.ok("source" in r);
    assert.ok(["keyword", "semantic", "both"].includes(r.source));
  }
});

await test("hybridSearch combined ranking boosts docs in both result sets", () => {
  // Unit test using reciprocalRankFusion directly to verify fusion logic
  const kwResults = [
    { id: "shared1" },
    { id: "kw_only" },
    { id: "shared2" },
  ];
  const semResults = [
    { id: "shared2" },
    { id: "shared1" },
    { id: "sem_only" },
  ];

  const scores = reciprocalRankFusion([kwResults, semResults]);

  // shared1 and shared2 appear in both, so should have higher scores
  assert.ok(scores.get("shared1") > scores.get("kw_only"), "shared doc should score higher than single-source doc");
  assert.ok(scores.get("shared2") > scores.get("sem_only"), "shared doc should score higher than single-source doc");
});
