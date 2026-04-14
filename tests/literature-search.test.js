/**
 * Phase 64.1: Literature search tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-literature-search-"));
process.env.STORAGE_PATH = TMP;

const {
  searchArxiv,
  searchPubmed,
  searchSemanticScholar,
  unifiedSearch,
  recordSearch,
  listSearches,
  listSources,
  LITERATURE_SOURCES,
  _reset,
} = await import("../lib/literature-search.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("LITERATURE_SOURCES includes the three expected sources", () => {
  for (const s of ["arxiv", "pubmed", "s2"]) {
    assert.ok(LITERATURE_SOURCES.includes(s), `missing source ${s}`);
  }
});

test("listSources returns metadata with IDs", () => {
  const list = listSources();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => s.id).sort(), ["arxiv", "pubmed", "s2"]);
  for (const s of list) {
    assert.ok(s.name);
    assert.ok(s.url);
    assert.equal(typeof s.live, "boolean");
  }
});

test("searchArxiv returns deterministic results based on query", async () => {
  const a = await searchArxiv({ query: "diffusion models", limit: 3 });
  const b = await searchArxiv({ query: "diffusion models", limit: 3 });
  assert.equal(a.length, 3);
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));
  for (const r of a) {
    assert.ok(r.id.startsWith("arxiv:"));
    assert.equal(r.source, "arxiv");
    assert.ok(r.title && r.abstract);
    assert.ok(Array.isArray(r.authors) && r.authors.length > 0);
    assert.ok(typeof r.year === "number" && r.year >= 2015 && r.year <= 2025);
    assert.ok(r.url.startsWith("https://arxiv.org/"));
  }
});

test("searchPubmed returns pubmed-prefixed IDs", async () => {
  const res = await searchPubmed({ query: "crispr cas9", limit: 5 });
  assert.equal(res.length, 5);
  for (const r of res) {
    assert.ok(r.id.startsWith("pubmed:"));
    assert.equal(r.source, "pubmed");
    assert.ok(r.url.startsWith("https://pubmed.ncbi.nlm.nih.gov/"));
  }
});

test("searchSemanticScholar returns s2-prefixed IDs", async () => {
  const res = await searchSemanticScholar({ query: "graph neural networks", limit: 4 });
  assert.equal(res.length, 4);
  for (const r of res) {
    assert.ok(r.id.startsWith("s2:"));
    assert.equal(r.source, "s2");
  }
});

test("unifiedSearch interleaves results across sources", async () => {
  const res = await unifiedSearch({ query: "transformer", sources: ["arxiv", "pubmed"], limit: 6 });
  const sources = new Set(res.map((r) => r.source));
  assert.ok(sources.has("arxiv"));
  assert.ok(sources.has("pubmed"));
  assert.ok(!sources.has("s2"), "should not contain unselected source");
  assert.ok(res.length <= 6);
});

test("unifiedSearch defaults to all sources when none specified", async () => {
  const res = await unifiedSearch({ query: "attention mechanisms", limit: 9 });
  const sources = new Set(res.map((r) => r.source));
  assert.ok(sources.has("arxiv"));
  assert.ok(sources.has("pubmed"));
  assert.ok(sources.has("s2"));
});

test("unifiedSearch clamps limit and filters invalid sources", async () => {
  const res = await unifiedSearch({ query: "foo", sources: ["bogus", "arxiv"], limit: 1000 });
  assert.ok(res.length <= 50);
  const sources = new Set(res.map((r) => r.source));
  assert.deepEqual([...sources], ["arxiv"]);
});

test("recordSearch persists entries and listSearches returns them", async () => {
  await _reset("ws-lit");
  const results = await unifiedSearch({ query: "alpha", limit: 3 });
  const rec = await recordSearch({ workspaceId: "ws-lit", query: "alpha", results });
  assert.ok(rec.id);
  assert.equal(rec.resultCount, results.length);

  const list = await listSearches("ws-lit");
  assert.equal(list.length, 1);
  assert.equal(list[0].query, "alpha");
});

test("listSearches returns entries newest first", async () => {
  await _reset("ws-order");
  await recordSearch({ workspaceId: "ws-order", query: "one", results: [] });
  await new Promise((r) => setTimeout(r, 2));
  await recordSearch({ workspaceId: "ws-order", query: "two", results: [] });
  const list = await listSearches("ws-order");
  assert.equal(list.length, 2);
  assert.equal(list[0].query, "two");
  assert.equal(list[1].query, "one");
});

test("searchArxiv clamps invalid limit values", async () => {
  const zero = await searchArxiv({ query: "x", limit: 0 });
  assert.ok(zero.length > 0);
  const neg = await searchArxiv({ query: "x", limit: -5 });
  assert.ok(neg.length > 0);
  const huge = await searchArxiv({ query: "x", limit: 100000 });
  assert.ok(huge.length <= 50);
});

test("different queries produce different IDs", async () => {
  const a = await searchArxiv({ query: "cats", limit: 2 });
  const b = await searchArxiv({ query: "dogs", limit: 2 });
  assert.notEqual(a[0].id, b[0].id);
});
