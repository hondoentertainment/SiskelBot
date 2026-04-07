import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Create isolated temp dir for each test run
const tempDir = mkdtempSync(join(tmpdir(), "kb-test-"));

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// Mock json-path-store before importing knowledge-store
const _store = {};

await test("indexDocument returns error when text is missing", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");
  const result = await indexDocument({ dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
  assert.ok(result.error.includes("text is required"));
});

await test("indexDocument returns error when text is empty", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");
  const result = await indexDocument({ text: "   ", dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
  assert.ok(result.error.includes("empty"));
});

await test("indexDocument returns error for invalid workspace", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");
  const result = await indexDocument({ text: "hello", workspace: "!@#$%", dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("indexDocument returns error for oversized doc", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");
  const bigText = "x".repeat(2000);
  const result = await indexDocument({ text: bigText, dataDir: tempDir, maxBytes: 100 });
  assert.equal(result.code, "DOC_TOO_LARGE");
});

await test("indexDocument indexes a document and returns id", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");
  const result = await indexDocument({ text: "Test document content", workspace: "default", title: "Test Doc", dataDir: tempDir });
  assert.ok(result.id);
  assert.equal(result.workspace, "default");
  assert.equal(result.title, "Test Doc");
  assert.ok(result.createdAt);
});

await test("list returns indexed documents", async () => {
  const { list } = await import("../lib/knowledge-store.js");
  const result = await list({ workspace: "default", dataDir: tempDir });
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length >= 1);
  assert.ok(result.items[0].id);
});

await test("list returns error for invalid workspace", async () => {
  const { list } = await import("../lib/knowledge-store.js");
  const result = await list({ workspace: "!invalid!", dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("search returns error when query is missing", async () => {
  const { search } = await import("../lib/knowledge-store.js");
  const result = await search({ dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("search returns empty snippets for empty query", async () => {
  const { search } = await import("../lib/knowledge-store.js");
  const result = await search({ query: "  ", workspace: "default", dataDir: tempDir });
  assert.deepEqual(result.snippets, []);
});

await test("search finds matching document", async () => {
  const { search } = await import("../lib/knowledge-store.js");
  const result = await search({ query: "Test document", workspace: "default", dataDir: tempDir });
  assert.ok(result.snippets.length > 0);
  assert.ok(result.snippets[0].snippet.includes("Test document"));
});

await test("search does not find non-matching query", async () => {
  const { search } = await import("../lib/knowledge-store.js");
  const result = await search({ query: "zzzznonexistent", workspace: "default", dataDir: tempDir });
  assert.equal(result.snippets.length, 0);
});

await test("getDocumentById returns error for missing id", async () => {
  const { getDocumentById } = await import("../lib/knowledge-store.js");
  const result = await getDocumentById({ dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("getDocumentById returns not found for bad id", async () => {
  const { getDocumentById } = await import("../lib/knowledge-store.js");
  const result = await getDocumentById({ id: "nonexistent-id", workspace: "default", dataDir: tempDir });
  assert.equal(result.code, "NOT_FOUND");
});

await test("getDocumentById returns document for valid id", async () => {
  const { indexDocument, getDocumentById } = await import("../lib/knowledge-store.js");
  const indexed = await indexDocument({ text: "Fetchable content", workspace: "default", title: "Fetch Test", dataDir: tempDir });
  const result = await getDocumentById({ id: indexed.id, workspace: "default", dataDir: tempDir });
  assert.equal(result.id, indexed.id);
  assert.equal(result.content, "Fetchable content");
});

await test("clearKnowledgeSearchCache does not throw", async () => {
  const { clearKnowledgeSearchCache } = await import("../lib/knowledge-store.js");
  clearKnowledgeSearchCache();
  clearKnowledgeSearchCache("default");
});
