/**
 * Phase 63.1: Repo-level RAG tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-repo-rag-"));
process.env.STORAGE_PATH = TMP;

const {
  tokenize,
  detectLanguage,
  extractSymbols,
  chunkFile,
  indexRepo,
  searchRepo,
  getFunctionByName,
  listFiles,
  rebuildIndex,
} = await import("../lib/repo-rag.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("tokenize drops language stopwords like function/const", () => {
  const t = tokenize("function add(a, b) { return a + b; }");
  assert.ok(t.includes("add"));
  assert.ok(!t.includes("function"));
  assert.ok(!t.includes("return"));
});

test("detectLanguage maps extensions", () => {
  assert.equal(detectLanguage("foo.js"), "javascript");
  assert.equal(detectLanguage("foo.ts"), "typescript");
  assert.equal(detectLanguage("foo.py"), "python");
  assert.equal(detectLanguage("foo.go"), "go");
  assert.equal(detectLanguage("foo.unknown"), "text");
});

test("extractSymbols finds JS functions and classes", () => {
  const text = `function alpha() { return 1; }\nclass Beta { }\nexport function gamma(x) { return x; }\n`;
  const syms = extractSymbols(text, "javascript");
  const names = syms.map((s) => s.name).sort();
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("Beta"));
  assert.ok(names.includes("gamma"));
});

test("extractSymbols handles Python def/class", () => {
  const text = `def alpha():\n    return 1\n\nclass Beta:\n    def method(self):\n        pass\n`;
  const syms = extractSymbols(text, "python");
  const names = syms.map((s) => s.name);
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("Beta"));
});

test("chunkFile splits into line buckets", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const chunks = chunkFile(text, 40);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 40);
});

test("indexRepo persists files and symbols", async () => {
  const result = await indexRepo([
    { path: "src/a.js", text: "function compute(x) { return x * 2; }\nexport const pi = 3.14;\n" },
    { path: "src/b.js", text: "class Widget { constructor() {} render() { return 'hi'; } }\n" },
    { path: "src/c.py", text: "def greet(name):\n    return 'hi ' + name\n", language: "python" },
  ]);
  assert.equal(result.fileCount, 3);
  assert.ok(result.symbolCount >= 3);
  assert.ok(result.chunkCount >= 3);
});

test("indexRepo rejects non-array", async () => {
  await assert.rejects(() => indexRepo(null));
});

test("searchRepo ranks matching chunks", async () => {
  const results = await searchRepo("compute return multiply", { k: 5 });
  assert.ok(results.length > 0);
  assert.ok(results[0].path === "src/a.js");
});

test("searchRepo filters by language", async () => {
  const results = await searchRepo("greet name", { language: "python" });
  assert.ok(results.length >= 1);
  assert.ok(results.every((r) => r.language === "python"));
});

test("searchRepo handles empty query", async () => {
  assert.deepEqual(await searchRepo(""), []);
  assert.deepEqual(await searchRepo("   "), []);
});

test("getFunctionByName finds symbols across files", async () => {
  const syms = await getFunctionByName("compute");
  assert.ok(syms.length >= 1);
  assert.equal(syms[0].kind, "function");
});

test("getFunctionByName returns [] for unknown", async () => {
  const syms = await getFunctionByName("nonexistent_symbol_xyz");
  assert.deepEqual(syms, []);
});

test("listFiles returns metadata without full text", async () => {
  const files = await listFiles();
  assert.ok(files.length >= 3);
  const first = files[0];
  assert.ok(first.path);
  assert.ok(first.language);
  assert.ok(typeof first.symbolCount === "number");
});

test("rebuildIndex reprocesses persisted files", async () => {
  const result = await rebuildIndex();
  assert.ok(result.fileCount >= 3);
});
