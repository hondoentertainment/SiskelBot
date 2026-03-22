/**
 * getDocumentById for agent drill-down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskel-knowledge-"));
process.env.KNOWLEDGE_DATA_DIR = tempDir;

const { indexDocument, getDocumentById } = await import("../lib/knowledge-store.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch (_) {}
});

test("getDocumentById returns content after indexDocument", () => {
  const body = "Unique marker xyz-123 for retrieval test.";
  const indexed = indexDocument({ text: body, workspace: "default", title: "T1" });
  assert.ok(indexed.id);
  const got = getDocumentById({ id: indexed.id, workspace: "default" });
  assert.equal(got.error, undefined);
  assert.equal(got.content, body);
  assert.equal(got.title, "T1");
});

test("getDocumentById not found", () => {
  const got = getDocumentById({ id: "00000000-0000-4000-8000-000000000000", workspace: "default" });
  assert.ok(got.error);
  assert.equal(got.code, "NOT_FOUND");
});
