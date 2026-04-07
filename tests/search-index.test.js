/**
 * Tests for lib/search-index.js — in-memory inverted index with TF-IDF ranking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchIndex, tokenize, extractSnippet } from "../lib/search-index.js";

// --- tokenize ---

test("tokenize: splits on whitespace and punctuation, lowercases", () => {
  const tokens = tokenize("Hello World! Foo-Bar");
  assert.ok(tokens.includes("hello"));
  assert.ok(tokens.includes("world"));
  assert.ok(tokens.includes("foo"));
  assert.ok(tokens.includes("bar"));
});

test("tokenize: removes stopwords", () => {
  const tokens = tokenize("the quick brown fox is a very fast animal");
  assert.ok(!tokens.includes("the"));
  assert.ok(!tokens.includes("is"));
  assert.ok(!tokens.includes("a"));
  assert.ok(!tokens.includes("very"));
  assert.ok(tokens.includes("quick"));
  assert.ok(tokens.includes("brown"));
  assert.ok(tokens.includes("fox"));
  assert.ok(tokens.includes("fast"));
  assert.ok(tokens.includes("animal"));
});

test("tokenize: removes single-character tokens", () => {
  const tokens = tokenize("I am a B student");
  assert.ok(!tokens.includes("i"));
  assert.ok(!tokens.includes("a"));
  assert.ok(!tokens.includes("b"));
});

test("tokenize: returns empty array for empty/null input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

// --- add / search / remove ---

test("add and search: finds documents by content", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "JavaScript is a programming language used for web development");
  idx.add("doc2", "Python is great for machine learning and data science");
  idx.add("doc3", "JavaScript frameworks like React and Vue are popular");

  const result = idx.search("JavaScript programming");
  assert.ok(result.total > 0);
  assert.equal(result.results[0].docId, "doc1");
});

test("search: returns empty for empty query", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "Some content here");
  assert.deepEqual(idx.search(""), { results: [], total: 0 });
  assert.deepEqual(idx.search("   "), { results: [], total: 0 });
  assert.deepEqual(idx.search(null), { results: [], total: 0 });
});

test("search: returns empty for query with only stopwords", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "Some content here");
  const result = idx.search("the a an is");
  assert.equal(result.total, 0);
});

test("remove: document no longer appears in search", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "machine learning algorithms");
  idx.add("doc2", "deep learning neural networks");

  assert.equal(idx.size(), 2);
  const before = idx.search("learning");
  assert.equal(before.total, 2);

  idx.remove("doc1");
  assert.equal(idx.size(), 1);

  const after = idx.search("learning");
  assert.equal(after.total, 1);
  assert.equal(after.results[0].docId, "doc2");
});

test("remove: returns false for non-existent doc", () => {
  const idx = createSearchIndex();
  assert.equal(idx.remove("nonexistent"), false);
});

test("add: re-adding same docId replaces old content", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "original content about cats");
  idx.add("doc1", "updated content about dogs");

  assert.equal(idx.size(), 1);

  const catResult = idx.search("cats");
  assert.equal(catResult.total, 0);

  const dogResult = idx.search("dogs");
  assert.equal(dogResult.total, 1);
});

// --- TF-IDF ranking ---

test("TF-IDF: document with higher term density ranks higher", () => {
  const idx = createSearchIndex();
  // doc1 has "machine" as 1/10 of its tokens — low density
  idx.add("doc1", "machine algorithms code software systems testing deployment builds pipelines servers");
  // doc2 has "machine" as 1/2 of its tokens — high density
  idx.add("doc2", "machine algorithms");

  const result = idx.search("machine");
  assert.ok(result.total >= 2);
  // doc2 has higher TF (term frequency normalized by doc length)
  assert.equal(result.results[0].docId, "doc2");
});

test("TF-IDF: rare terms boost relevance", () => {
  const idx = createSearchIndex();
  // "quantum" only appears in doc1 — high IDF
  idx.add("doc1", "quantum computing research advances in quantum physics");
  idx.add("doc2", "computing research advances in software engineering");
  idx.add("doc3", "research advances in biology and chemistry");

  const result = idx.search("quantum");
  assert.equal(result.total, 1);
  assert.equal(result.results[0].docId, "doc1");
});

// --- snippet extraction with highlighting ---

test("extractSnippet: highlights matching terms with <mark> tags", () => {
  const text = "The quick brown fox jumps over the lazy dog in the garden";
  const snippet = extractSnippet(text, "fox");
  assert.ok(snippet.includes("<mark>fox</mark>"), `Expected <mark>fox</mark> in: ${snippet}`);
});

test("extractSnippet: returns context around match", () => {
  const text = "A".repeat(200) + " important keyword here " + "B".repeat(200);
  const snippet = extractSnippet(text, "keyword", 100);
  assert.ok(snippet.includes("<mark>keyword</mark>"));
  assert.ok(snippet.includes("..."), "Should have ellipsis for truncated text");
});

test("extractSnippet: handles empty input", () => {
  assert.equal(extractSnippet("", "test"), "");
  assert.equal(extractSnippet(null, "test"), "");
  assert.equal(extractSnippet("text", ""), "");
});

// --- persistence (serialize / deserialize) ---

test("serialize and deserialize: roundtrip preserves index", () => {
  const idx1 = createSearchIndex();
  idx1.add("doc1", "machine learning algorithms", { type: "knowledge" });
  idx1.add("doc2", "deep learning neural networks", { type: "conversation" });

  const serialized = idx1.serialize();
  assert.equal(typeof serialized, "string");

  const idx2 = createSearchIndex();
  idx2.deserialize(serialized);

  assert.equal(idx2.size(), 2);

  const result = idx2.search("learning");
  assert.equal(result.total, 2);
});

test("deserialize: handles parsed object (not just string)", () => {
  const idx1 = createSearchIndex();
  idx1.add("doc1", "test content");
  const data = JSON.parse(idx1.serialize());

  const idx2 = createSearchIndex();
  idx2.deserialize(data);
  assert.equal(idx2.size(), 1);
});

test("deserialize: handles empty/null data gracefully", () => {
  const idx = createSearchIndex();
  idx.deserialize(null);
  assert.equal(idx.size(), 0);

  idx.deserialize("{}");
  assert.equal(idx.size(), 0);
});

// --- size and clear ---

test("size: returns number of indexed documents", () => {
  const idx = createSearchIndex();
  assert.equal(idx.size(), 0);
  idx.add("doc1", "content one");
  assert.equal(idx.size(), 1);
  idx.add("doc2", "content two");
  assert.equal(idx.size(), 2);
});

test("clear: removes all documents", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "content one");
  idx.add("doc2", "content two");
  assert.equal(idx.size(), 2);

  idx.clear();
  assert.equal(idx.size(), 0);
  assert.deepEqual(idx.search("content"), { results: [], total: 0 });
});

// --- search options ---

test("search: respects limit and offset", () => {
  const idx = createSearchIndex();
  for (let i = 0; i < 10; i++) {
    idx.add(`doc${i}`, `document about testing number ${i}`);
  }

  const page1 = idx.search("testing", { limit: 3, offset: 0 });
  assert.equal(page1.results.length, 3);
  assert.equal(page1.total, 10);

  const page2 = idx.search("testing", { limit: 3, offset: 3 });
  assert.equal(page2.results.length, 3);
  assert.notEqual(page1.results[0].docId, page2.results[0].docId);
});

test("search: filters by type via metadata", () => {
  const idx = createSearchIndex();
  idx.add("conv1", "conversation about deployment", { type: "conversation" });
  idx.add("know1", "knowledge doc about deployment", { type: "knowledge" });

  const convOnly = idx.search("deployment", { type: "conversation" });
  assert.equal(convOnly.total, 1);
  assert.equal(convOnly.results[0].docId, "conv1");

  const knowOnly = idx.search("deployment", { type: "knowledge" });
  assert.equal(knowOnly.total, 1);
  assert.equal(knowOnly.results[0].docId, "know1");

  const all = idx.search("deployment");
  assert.equal(all.total, 2);
});

// --- metadata preserved ---

test("search results include metadata", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "testing metadata preservation", { type: "conversation", title: "Test" });

  const result = idx.search("metadata");
  assert.equal(result.results[0].metadata.type, "conversation");
  assert.equal(result.results[0].metadata.title, "Test");
});

// --- edge cases ---

test("add: ignores null/undefined docId", () => {
  const idx = createSearchIndex();
  idx.add(null, "some text");
  idx.add(undefined, "some text");
  assert.equal(idx.size(), 0);
});

test("add: ignores non-string text", () => {
  const idx = createSearchIndex();
  idx.add("doc1", 12345);
  idx.add("doc2", null);
  assert.equal(idx.size(), 0);
});

test("search: scores are rounded to 4 decimal places", () => {
  const idx = createSearchIndex();
  idx.add("doc1", "precise scoring test");
  const result = idx.search("scoring");
  const score = result.results[0].score;
  const decimals = String(score).split(".")[1] || "";
  assert.ok(decimals.length <= 4, `Score ${score} has more than 4 decimal places`);
});
