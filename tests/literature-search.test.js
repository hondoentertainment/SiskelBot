/**
 * Phase 64.1: Literature search tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-literature-"));
process.env.STORAGE_PATH = TMP;

const {
  searchLiterature,
  getPaper,
  listProviders,
  cachePaper,
  clearCache,
  listCached,
} = await import("../lib/literature-search.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("listProviders returns the 3 built-ins", () => {
  const list = listProviders();
  const ids = list.map((p) => p.id).sort();
  assert.deepEqual(ids, ["arxiv", "pubmed", "semantic_scholar"]);
});

test("searchLiterature returns empty when query is empty", async () => {
  const out = await searchLiterature("");
  assert.deepEqual(out.results, []);
});

test("searchLiterature uses the injected fetch", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return {
      data: [
        { id: "abc", title: "Paper A", authors: [{ name: "Alice" }], abstract: "test abstract", year: 2024 },
      ],
    };
  };
  const out = await searchLiterature("transformer", { providers: ["semantic_scholar"], fetch: fakeFetch });
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, "Paper A");
  assert.ok(calls[0].includes("transformer"));
});

test("searchLiterature caches results", async () => {
  const fakeFetch = async () => ({ data: [{ id: "cached_1", title: "Cached" }] });
  await searchLiterature("q", { providers: ["arxiv"], fetch: fakeFetch });
  const cached = await listCached();
  assert.ok(cached.some((p) => p.id === "cached_1"));
});

test("searchLiterature handles provider errors gracefully", async () => {
  const fakeFetch = async () => { throw new Error("boom"); };
  const out = await searchLiterature("q", { providers: ["arxiv"], fetch: fakeFetch });
  assert.equal(out.results.length, 0);
});

test("cachePaper persists a manual paper", async () => {
  const rec = await cachePaper({
    id: "manual_1",
    title: "Manual",
    authors: ["Bob"],
    abstract: "hello",
    year: 2023,
  });
  assert.equal(rec.id, "manual_1");
  assert.ok(rec.cachedAt);
});

test("cachePaper rejects invalid input", async () => {
  await assert.rejects(() => cachePaper(null));
  await assert.rejects(() => cachePaper({}));
});

test("getPaper returns from cache when available", async () => {
  await cachePaper({ id: "cache_hit", title: "Hit" });
  const paper = await getPaper("cache_hit");
  assert.ok(paper);
  assert.equal(paper.title, "Hit");
});

test("getPaper uses fetch when cache miss", async () => {
  const fakeFetch = async () => ({ title: "From net", authors: [{ name: "Net" }], year: 2022 });
  const paper = await getPaper("net_id", { fetch: fakeFetch, useCache: false });
  assert.ok(paper);
  assert.equal(paper.title, "From net");
});

test("getPaper rejects empty id", async () => {
  await assert.rejects(() => getPaper(""));
});

test("clearCache empties the cache", async () => {
  await clearCache();
  const list = await listCached();
  assert.deepEqual(list, []);
});

test("searchLiterature reports sources queried", async () => {
  const out = await searchLiterature("x", { providers: ["arxiv", "pubmed"] });
  assert.deepEqual(out.sources.sort(), ["arxiv", "pubmed"]);
});
