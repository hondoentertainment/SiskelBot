import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  saveDocumentVersion,
  getDocumentHistory,
  getDocumentVersion,
  rollbackDocument,
  diffVersions,
  computeDiff,
} from "../lib/document-versioning.js";

const tempDir = mkdtempSync(join(tmpdir(), "doc-version-test-"));

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// --- computeDiff tests ---

await test("computeDiff returns empty for identical strings", () => {
  const result = computeDiff("hello\nworld", "hello\nworld");
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.changes.length, 0);
});

await test("computeDiff detects additions", () => {
  const result = computeDiff("line1", "line1\nline2");
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 0);
  assert.ok(result.changes.some((c) => c.type === "add" && c.content === "line2"));
});

await test("computeDiff detects deletions", () => {
  const result = computeDiff("line1\nline2", "line1");
  assert.equal(result.deletions, 1);
  assert.ok(result.changes.some((c) => c.type === "delete" && c.content === "line2"));
});

await test("computeDiff detects modifications", () => {
  const result = computeDiff("old line", "new line");
  assert.ok(result.additions > 0 || result.deletions > 0);
  assert.ok(result.changes.length > 0);
});

await test("computeDiff handles empty old text", () => {
  const result = computeDiff("", "new content");
  assert.equal(result.additions, 1);
  assert.equal(result.deletions, 0);
});

await test("computeDiff handles empty new text", () => {
  const result = computeDiff("old content", "");
  assert.equal(result.deletions, 1);
  assert.equal(result.additions, 0);
});

await test("computeDiff handles both empty", () => {
  const result = computeDiff("", "");
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.changes.length, 0);
});

await test("computeDiff handles multi-line changes", () => {
  const old = "line1\nline2\nline3\nline4";
  const now = "line1\nmodified\nline3\nnew line\nline4";
  const result = computeDiff(old, now);
  assert.ok(result.changes.length > 0);
});

// --- saveDocumentVersion tests ---

await test("saveDocumentVersion returns error for missing docId", async () => {
  const result = await saveDocumentVersion(null, "content", {}, { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("saveDocumentVersion saves a version and returns versionId", async () => {
  const result = await saveDocumentVersion("doc1", "Initial content", { title: "Test" }, { workspace: "default", dataDir: tempDir });
  assert.ok(result.versionId);
  assert.ok(result.createdAt);
  assert.ok(result.diff);
  assert.equal(typeof result.diff.additions, "number");
  assert.equal(typeof result.diff.deletions, "number");
});

await test("saveDocumentVersion computes diff from previous version", async () => {
  // First version
  await saveDocumentVersion("doc2", "Version 1 content", {}, { workspace: "default", dataDir: tempDir });
  // Second version with changes
  const result = await saveDocumentVersion("doc2", "Version 2 content", {}, { workspace: "default", dataDir: tempDir });
  assert.ok(result.versionId);
  // There should be some diff since the content changed
  assert.ok(result.diff.additions > 0 || result.diff.deletions > 0);
});

// --- getDocumentHistory tests ---

await test("getDocumentHistory returns error for missing docId", async () => {
  const result = await getDocumentHistory(null, 50, { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("getDocumentHistory returns empty for unknown doc", async () => {
  const result = await getDocumentHistory("nonexistent", 50, { workspace: "default", dataDir: tempDir });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

await test("getDocumentHistory returns versions in reverse chronological order", async () => {
  // Save multiple versions
  await saveDocumentVersion("histdoc", "Version A", {}, { workspace: "default", dataDir: tempDir });
  await saveDocumentVersion("histdoc", "Version B", {}, { workspace: "default", dataDir: tempDir });
  await saveDocumentVersion("histdoc", "Version C", {}, { workspace: "default", dataDir: tempDir });

  const history = await getDocumentHistory("histdoc", 50, { workspace: "default", dataDir: tempDir });
  assert.ok(Array.isArray(history));
  assert.ok(history.length >= 3);
  // Most recent first
  assert.ok(history[0].createdAt >= history[1].createdAt);
  // Each entry has expected fields
  for (const h of history) {
    assert.ok(h.versionId);
    assert.ok(h.createdAt);
    assert.ok(h.diffSummary);
  }
});

await test("getDocumentHistory respects limit", async () => {
  const history = await getDocumentHistory("histdoc", 2, { workspace: "default", dataDir: tempDir });
  assert.ok(history.length <= 2);
});

// --- getDocumentVersion tests ---

await test("getDocumentVersion returns error for missing docId", async () => {
  const result = await getDocumentVersion(null, "v1", { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("getDocumentVersion returns error for missing versionId", async () => {
  const result = await getDocumentVersion("doc1", null, { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("getDocumentVersion returns NOT_FOUND for unknown version", async () => {
  const result = await getDocumentVersion("doc1", "nonexistent", { workspace: "default", dataDir: tempDir });
  assert.equal(result.code, "NOT_FOUND");
});

await test("getDocumentVersion returns stored version content", async () => {
  const saved = await saveDocumentVersion("verdoc", "Specific version content", { author: "test" }, { workspace: "default", dataDir: tempDir });
  const result = await getDocumentVersion("verdoc", saved.versionId, { workspace: "default", dataDir: tempDir });
  assert.equal(result.versionId, saved.versionId);
  assert.equal(result.content, "Specific version content");
  assert.equal(result.metadata.author, "test");
  assert.ok(result.createdAt);
});

// --- rollbackDocument tests ---

await test("rollbackDocument returns error for missing docId", async () => {
  const result = await rollbackDocument(null, "v1", { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("rollbackDocument returns error for missing versionId", async () => {
  const result = await rollbackDocument("doc1", null, { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("rollbackDocument returns NOT_FOUND for unknown version", async () => {
  const result = await rollbackDocument("doc1", "nonexistent", { workspace: "default", dataDir: tempDir });
  assert.equal(result.code, "NOT_FOUND");
});

await test("rollbackDocument creates new version with old content", async () => {
  // Save original
  const v1 = await saveDocumentVersion("rbdoc", "Original content", {}, { workspace: "default", dataDir: tempDir });
  // Save update
  await saveDocumentVersion("rbdoc", "Updated content", {}, { workspace: "default", dataDir: tempDir });

  // Rollback to v1
  const result = await rollbackDocument("rbdoc", v1.versionId, { workspace: "default", dataDir: tempDir });
  assert.ok(result.versionId);
  assert.equal(result.rolledBackTo, v1.versionId);
  assert.equal(result.content, "Original content");
  assert.ok(result.createdAt);

  // Verify a new version was created (not the same as original)
  assert.notEqual(result.versionId, v1.versionId);

  // Verify the new version content matches the original
  const newVersion = await getDocumentVersion("rbdoc", result.versionId, { workspace: "default", dataDir: tempDir });
  assert.equal(newVersion.content, "Original content");
});

// --- diffVersions tests ---

await test("diffVersions returns error for missing docId", async () => {
  const result = await diffVersions(null, "v1", "v2", { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("diffVersions returns error for missing v1", async () => {
  const result = await diffVersions("doc1", null, "v2", { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("diffVersions returns error for missing v2", async () => {
  const result = await diffVersions("doc1", "v1", null, { dataDir: tempDir });
  assert.equal(result.code, "INVALID_INPUT");
});

await test("diffVersions returns NOT_FOUND for unknown v1", async () => {
  const result = await diffVersions("doc1", "nonexistent", "alsonotfound", { workspace: "default", dataDir: tempDir });
  assert.equal(result.code, "NOT_FOUND");
});

await test("diffVersions computes diff between two versions", async () => {
  const v1 = await saveDocumentVersion("diffdoc", "Line one\nLine two\nLine three", {}, { workspace: "default", dataDir: tempDir });
  const v2 = await saveDocumentVersion("diffdoc", "Line one\nModified line\nLine three\nLine four", {}, { workspace: "default", dataDir: tempDir });

  const result = await diffVersions("diffdoc", v1.versionId, v2.versionId, { workspace: "default", dataDir: tempDir });
  assert.ok(!result.error);
  assert.ok(typeof result.additions === "number");
  assert.ok(typeof result.deletions === "number");
  assert.ok(Array.isArray(result.changes));
  assert.ok(result.changes.length > 0);

  // Verify each change has expected shape
  for (const change of result.changes) {
    assert.ok(["add", "delete"].includes(change.type));
    assert.ok(typeof change.line === "number");
    assert.ok(typeof change.content === "string");
  }
});

await test("diffVersions returns empty diff for identical versions", async () => {
  const v1 = await saveDocumentVersion("samedoc", "Same content", {}, { workspace: "default", dataDir: tempDir });
  const v2 = await saveDocumentVersion("samedoc", "Same content", {}, { workspace: "default", dataDir: tempDir });

  const result = await diffVersions("samedoc", v1.versionId, v2.versionId, { workspace: "default", dataDir: tempDir });
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 0);
  assert.equal(result.changes.length, 0);
});

// --- Versioned indexing integration test ---

await test("indexDocument with versioned=true saves version before replacing", async () => {
  const { indexDocument } = await import("../lib/knowledge-store.js");

  // Create initial doc
  const first = await indexDocument({
    text: "Original versioned content",
    workspace: "versionedws",
    title: "VersionedDoc",
    dataDir: tempDir,
  });
  assert.ok(first.id);

  // Re-index with versioned=true and same title
  const second = await indexDocument({
    text: "Updated versioned content",
    workspace: "versionedws",
    title: "VersionedDoc",
    versioned: true,
    dataDir: tempDir,
  });
  assert.ok(second.id);

  // Check version history was created for the original doc
  const history = await getDocumentHistory(first.id, 50, { workspace: "versionedws", dataDir: tempDir });
  assert.ok(Array.isArray(history));
  assert.ok(history.length >= 1, "version history should have at least one entry");
  // The saved version should have the original content
  const savedVersion = await getDocumentVersion(first.id, history[0].versionId, { workspace: "versionedws", dataDir: tempDir });
  assert.equal(savedVersion.content, "Original versioned content");
});
