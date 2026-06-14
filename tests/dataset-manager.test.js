/**
 * Tests for lib/dataset-manager.js — dataset versioning, tagging, splitting, import/export.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tempDir = mkdtempSync(join(tmpdir(), "dataset-mgr-test-"));
process.env.STORAGE_PATH = tempDir;

// Import AFTER setting STORAGE_PATH so all paths resolve inside tempDir.
const {
  createDataset,
  addExamples,
  removeExamples,
  listDatasets,
  getDataset,
  deleteDataset,
  tagDataset,
  splitDataset,
  getDatasetVersions,
  compareVersions,
  exportDataset,
  importDataset,
  getDatasetStats,
  deduplicateExamples,
  validateQuality,
} = await import("../lib/dataset-manager.js");

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const WS = "dstest";

// --- createDataset ---

test("createDataset creates a dataset with initial version 1.0.0", async () => {
  const ds = await createDataset("My Dataset", "Test dataset", WS);
  assert.ok(ds.id);
  assert.equal(ds.name, "My Dataset");
  assert.equal(ds.description, "Test dataset");
  assert.equal(ds.workspaceId, WS);
  assert.equal(ds.currentVersion, "1.0.0");
  assert.equal(ds.versions.length, 1);
  assert.equal(ds.versions[0].examples.length, 0);
  assert.ok(ds.createdAt);
});

test("createDataset rejects missing name", async () => {
  const res = await createDataset("", "", WS);
  assert.equal(res.code, "INVALID_INPUT");
});

// --- addExamples / versioning ---

test("addExamples creates a new version each call", async () => {
  const ds = await createDataset("Versioned", "", WS);
  const v1 = await addExamples(ds.id, [
    { input: "hello", output: "world" },
    { input: "foo", output: "bar" },
  ]);
  assert.equal(v1.version, "1.1.0");
  assert.equal(v1.exampleCount, 2);
  assert.equal(v1.added, 2);

  const v2 = await addExamples(ds.id, [{ input: "ping", output: "pong" }]);
  assert.equal(v2.version, "1.2.0");
  assert.equal(v2.exampleCount, 3);

  const versions = await getDatasetVersions(ds.id);
  assert.ok(Array.isArray(versions));
  assert.equal(versions.length, 3);
  assert.equal(versions[versions.length - 1].version, "1.2.0");
});

test("addExamples validates input array", async () => {
  const ds = await createDataset("Validation", "", WS);
  const res = await addExamples(ds.id, "not-an-array");
  assert.equal(res.code, "INVALID_INPUT");
});

test("addExamples returns NOT_FOUND for unknown dataset", async () => {
  const res = await addExamples("nonexistent-id", [{ input: "a", output: "b" }]);
  assert.equal(res.code, "NOT_FOUND");
});

// --- removeExamples ---

test("removeExamples creates new version with remaining examples", async () => {
  const ds = await createDataset("ToRemove", "", WS);
  await addExamples(ds.id, [
    { id: "ex1", input: "a", output: "b" },
    { id: "ex2", input: "c", output: "d" },
    { id: "ex3", input: "e", output: "f" },
  ]);
  const res = await removeExamples(ds.id, ["ex2"]);
  assert.equal(res.removed, 1);
  assert.equal(res.exampleCount, 2);
  assert.equal(res.version, "1.2.0");

  const loaded = await getDataset(ds.id);
  const latest = loaded.versions[loaded.versions.length - 1];
  const ids = latest.examples.map((e) => e.id);
  assert.ok(!ids.includes("ex2"));
  assert.ok(ids.includes("ex1"));
  assert.ok(ids.includes("ex3"));
});

// --- listDatasets ---

test("listDatasets returns workspace datasets", async () => {
  const list = await listDatasets(WS);
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
  assert.ok(list.every((d) => d.id));
});

// --- getDataset with version/tag ---

test("getDataset returns specific version when requested", async () => {
  const ds = await createDataset("SpecificVersion", "", WS);
  await addExamples(ds.id, [{ input: "q1", output: "a1" }]);
  await addExamples(ds.id, [{ input: "q2", output: "a2" }]);

  const at110 = await getDataset(ds.id, "1.1.0");
  assert.ok(!at110.error);
  assert.equal(at110.version.version, "1.1.0");
  assert.equal(at110.version.examples.length, 1);
});

test("getDataset returns NOT_FOUND for unknown version", async () => {
  const ds = await createDataset("GetUnknownVersion", "", WS);
  const res = await getDataset(ds.id, "9.9.9");
  assert.equal(res.code, "NOT_FOUND");
});

// --- tagDataset ---

test("tagDataset marks a version with a label", async () => {
  const ds = await createDataset("Tagged", "", WS);
  await addExamples(ds.id, [{ input: "x", output: "y" }]);
  const tagged = await tagDataset(ds.id, "1.1.0", "production");
  assert.ok(!tagged.error);
  assert.equal(tagged.tag, "production");

  // Get by tag
  const byTag = await getDataset(ds.id, "production");
  assert.ok(!byTag.error);
  assert.equal(byTag.version.version, "1.1.0");
});

test("tagDataset rejects unknown version", async () => {
  const ds = await createDataset("TagUnknown", "", WS);
  const res = await tagDataset(ds.id, "9.9.9", "stale");
  assert.equal(res.code, "NOT_FOUND");
});

// --- splitDataset ---

test("splitDataset deterministically partitions examples", async () => {
  const ds = await createDataset("ToSplit", "", WS);
  const examples = [];
  for (let i = 0; i < 100; i++) {
    examples.push({ id: `ex-${i}`, input: `in-${i}`, output: `out-${i}` });
  }
  await addExamples(ds.id, examples);

  const s1 = await splitDataset(ds.id, { train: 0.8, val: 0.1, test: 0.1 });
  assert.ok(Array.isArray(s1.train));
  assert.ok(Array.isArray(s1.val));
  assert.ok(Array.isArray(s1.test));
  assert.equal(s1.train.length + s1.val.length + s1.test.length, 100);

  // Deterministic: second call must match.
  const s2 = await splitDataset(ds.id, { train: 0.8, val: 0.1, test: 0.1 });
  assert.deepEqual(
    s1.train.map((e) => e.id).sort(),
    s2.train.map((e) => e.id).sort(),
  );
  assert.deepEqual(
    s1.val.map((e) => e.id).sort(),
    s2.val.map((e) => e.id).sort(),
  );
  assert.deepEqual(
    s1.test.map((e) => e.id).sort(),
    s2.test.map((e) => e.id).sort(),
  );

  // Train should be the largest bucket (approximately 80%).
  assert.ok(s1.train.length >= 60 && s1.train.length <= 95);
});

test("splitDataset rejects zero-sum ratios", async () => {
  const ds = await createDataset("BadSplit", "", WS);
  const res = await splitDataset(ds.id, { train: 0, val: 0, test: 0 });
  assert.equal(res.code, "INVALID_INPUT");
});

// --- compareVersions ---

test("compareVersions reports added/removed/modified between versions", async () => {
  const ds = await createDataset("Compare", "", WS);
  await addExamples(ds.id, [
    { id: "a", input: "hello", output: "world" },
    { id: "b", input: "foo", output: "bar" },
  ]);
  // Modify "b" and add "c", remove "a" via explicit remove.
  await addExamples(ds.id, [{ id: "b", input: "foo", output: "baz" }, { id: "c", input: "new", output: "one" }]);
  await removeExamples(ds.id, ["a"]);

  const versions = await getDatasetVersions(ds.id);
  const first = versions[1].version;       // 1.1.0 — two initial examples
  const last = versions[versions.length - 1].version; // after removal

  const diff = await compareVersions(ds.id, first, last);
  assert.ok(!diff.error);
  const addedIds = diff.added.map((e) => e.id);
  const removedIds = diff.removed.map((e) => e.id);
  const modifiedIds = diff.modified.map((m) => m.id);
  assert.ok(addedIds.includes("c"));
  assert.ok(removedIds.includes("a"));
  assert.ok(modifiedIds.includes("b"));
});

// --- export/import roundtrip ---

test("exportDataset jsonl and importDataset roundtrip", async () => {
  const ds = await createDataset("Export", "", WS);
  await addExamples(ds.id, [
    { input: "question 1", output: "answer 1", tags: ["alpha"] },
    { input: "question 2", output: "answer 2", tags: ["beta"] },
  ]);

  const exported = await exportDataset(ds.id, "jsonl");
  assert.equal(exported.format, "jsonl");
  assert.ok(exported.data.includes("question 1"));

  const imported = await importDataset("Roundtrip", exported.data, "jsonl", WS);
  assert.ok(imported.datasetId);
  assert.equal(imported.imported, 2);

  const loaded = await getDataset(imported.datasetId);
  const latest = loaded.versions[loaded.versions.length - 1];
  assert.equal(latest.examples.length, 2);
  const inputs = latest.examples.map((e) => e.input).sort();
  assert.deepEqual(inputs, ["question 1", "question 2"]);
});

test("exportDataset openai-ft produces messages format", async () => {
  const ds = await createDataset("OpenAIExport", "", WS);
  await addExamples(ds.id, [{ input: "hi", output: "hello there" }]);
  const exported = await exportDataset(ds.id, "openai-ft");
  assert.equal(exported.format, "openai-ft");
  const line = JSON.parse(exported.data.split("\n")[0]);
  assert.ok(Array.isArray(line.messages));
  assert.equal(line.messages[0].role, "user");
  assert.equal(line.messages[0].content, "hi");
  assert.equal(line.messages[1].role, "assistant");
  assert.equal(line.messages[1].content, "hello there");
});

test("exportDataset csv and importDataset csv roundtrip", async () => {
  const ds = await createDataset("CsvExport", "", WS);
  await addExamples(ds.id, [
    { input: "plain", output: "simple" },
    { input: "with,comma", output: 'quoted "value"' },
  ]);
  const exported = await exportDataset(ds.id, "csv");
  assert.equal(exported.format, "csv");

  const imported = await importDataset("CsvRoundtrip", exported.data, "csv", WS);
  assert.equal(imported.imported, 2);
});

test("exportDataset rejects unknown format", async () => {
  const ds = await createDataset("BadExport", "", WS);
  const res = await exportDataset(ds.id, "xml");
  assert.equal(res.code, "INVALID_FORMAT");
});

// --- getDatasetStats ---

test("getDatasetStats computes totals, averages, and tag distribution", async () => {
  const ds = await createDataset("Stats", "", WS);
  await addExamples(ds.id, [
    { input: "short", output: "resp", tags: ["x"] },
    { input: "longer input here", output: "longer response here", tags: ["x", "y"] },
    { input: "another", output: "reply", tags: ["y"] },
  ]);
  const stats = await getDatasetStats(ds.id);
  assert.equal(stats.totalExamples, 3);
  assert.ok(stats.avgInputLength > 0);
  assert.ok(stats.avgOutputLength > 0);
  assert.equal(stats.tagDistribution.x, 2);
  assert.equal(stats.tagDistribution.y, 2);
  assert.ok(stats.versionCount >= 2);
});

// --- deleteDataset ---

test("deleteDataset removes dataset and subsequent gets return NOT_FOUND", async () => {
  const ds = await createDataset("ToDelete", "", WS);
  const res = await deleteDataset(ds.id);
  assert.equal(res.deleted, true);

  const fetched = await getDataset(ds.id);
  assert.equal(fetched.code, "NOT_FOUND");
});

// --- deduplicateExamples ---

test("deduplicateExamples removes duplicates by input+output hash", () => {
  const examples = [
    { input: "hi", output: "hello" },
    { input: "hi", output: "hello" },
    { input: "hi", output: "hi there" },
    { input: "bye", output: "goodbye" },
  ];
  const deduped = deduplicateExamples(examples);
  assert.equal(deduped.length, 3);
});

test("deduplicateExamples handles non-array input", () => {
  assert.deepEqual(deduplicateExamples(null), []);
  assert.deepEqual(deduplicateExamples("bad"), []);
});

// --- validateQuality ---

test("validateQuality flags missing input and output", () => {
  const { valid, issues } = validateQuality([
    { input: "", output: "reply" },
    { input: "question", output: "" },
    { input: "ok", output: "good" },
  ]);
  assert.equal(valid, false);
  assert.ok(issues.some((i) => i.type === "MISSING_INPUT"));
  assert.ok(issues.some((i) => i.type === "MISSING_OUTPUT"));
});

test("validateQuality flags inputs below min length", () => {
  const { valid, issues } = validateQuality(
    [{ input: "a", output: "b" }],
    { minInputLength: 5, minOutputLength: 5 },
  );
  assert.equal(valid, false);
  assert.ok(issues.some((i) => i.type === "INPUT_TOO_SHORT"));
  assert.ok(issues.some((i) => i.type === "OUTPUT_TOO_SHORT"));
});

test("validateQuality returns valid for clean dataset", () => {
  const { valid, issues } = validateQuality([
    { input: "what is the capital of France?", output: "Paris" },
    { input: "what is 2 + 2?", output: "4" },
  ]);
  assert.equal(valid, true);
  assert.equal(issues.length, 0);
});

test("validateQuality rejects non-array input", () => {
  const res = validateQuality("not an array");
  assert.equal(res.valid, false);
  assert.equal(res.issues[0].type, "INVALID_TYPE");
});
