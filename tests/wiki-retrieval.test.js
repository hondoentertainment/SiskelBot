/**
 * Phase 68.2: Wiki retrieval tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-wiki-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  indexArticle,
  searchArticles,
  getArticle,
  listArticles,
  clearIndex,
  tokenize,
} = await import("../lib/wiki-retrieval.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("tokenize lowercases and strips stopwords", () => {
  const out = tokenize("The quick brown fox JUMPS over the lazy dog");
  assert.ok(out.includes("quick"));
  assert.ok(out.includes("brown"));
  assert.ok(!out.includes("the"));
  assert.ok(!out.includes("over"));
});

test("indexArticle stores articles and getArticle retrieves", async () => {
  await clearIndex();
  const rec = await indexArticle({
    title: "Express Framework",
    text: "Express is a minimal Node.js web application framework used widely.",
    tags: ["web", "node"],
  });
  assert.ok(rec.id);
  assert.equal(rec.title, "Express Framework");
  const fetched = await getArticle(rec.id);
  assert.ok(fetched);
  assert.equal(fetched.title, "Express Framework");
  assert.ok(!fetched.tf); // tf cache stripped
});

test("indexArticle rejects invalid input", async () => {
  await assert.rejects(() => indexArticle(null));
  await assert.rejects(() => indexArticle({ title: "", text: "x" }));
  await assert.rejects(() => indexArticle({ title: "ok", text: 42 }));
});

test("searchArticles returns relevant results ranked by score", async () => {
  await clearIndex();
  await indexArticle({ title: "Node.js", text: "Node.js is a runtime built on V8 for running JavaScript on servers." });
  await indexArticle({ title: "Python", text: "Python is a high-level interpreted programming language." });
  await indexArticle({ title: "Rust", text: "Rust is a systems programming language focused on safety." });
  const results = await searchArticles("javascript runtime servers");
  assert.ok(results.length > 0);
  assert.equal(results[0].title, "Node.js");
  assert.ok(results[0].score > 0);
  assert.ok(results[0].snippet);
});

test("searchArticles gives exact title match a bonus", async () => {
  await clearIndex();
  await indexArticle({ title: "GraphQL", text: "A query language for APIs." });
  await indexArticle({ title: "REST", text: "GraphQL is an alternative to REST with a schema." });
  const results = await searchArticles("GraphQL");
  assert.ok(results.length >= 2);
  assert.equal(results[0].title, "GraphQL");
});

test("searchArticles filters by tag", async () => {
  await clearIndex();
  await indexArticle({ title: "A", text: "deploy build cloud", tags: ["ops"] });
  await indexArticle({ title: "B", text: "deploy build cloud", tags: ["dev"] });
  const opsOnly = await searchArticles("deploy cloud", { tag: "ops" });
  assert.equal(opsOnly.length, 1);
  assert.equal(opsOnly[0].title, "A");
});

test("searchArticles returns empty for empty query or empty index", async () => {
  await clearIndex();
  assert.deepEqual(await searchArticles(""), []);
  assert.deepEqual(await searchArticles("   "), []);
  assert.deepEqual(await searchArticles("anything"), []);
});

test("searchArticles respects k limit", async () => {
  await clearIndex();
  for (let i = 0; i < 6; i++) {
    await indexArticle({ title: `T${i}`, text: "duplicate content duplicate content duplicate content" });
  }
  const results = await searchArticles("duplicate content", { k: 3 });
  assert.equal(results.length, 3);
});

test("listArticles returns indexed records without tf cache or full text", async () => {
  await clearIndex();
  await indexArticle({ title: "One", text: "alpha beta gamma" });
  await indexArticle({ title: "Two", text: "delta epsilon zeta" });
  const all = await listArticles();
  assert.equal(all.length, 2);
  assert.ok(!all[0].tf);
  assert.ok(!all[0].text);
});

test("clearIndex empties the store", async () => {
  await indexArticle({ title: "To Be Cleared", text: "transient" });
  const { cleared } = await clearIndex();
  assert.ok(cleared >= 1);
  const all = await listArticles();
  assert.equal(all.length, 0);
});
