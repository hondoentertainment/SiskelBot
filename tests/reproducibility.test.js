/**
 * Phase 64.5: Reproducibility check tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-repro-"));
process.env.STORAGE_PATH = TMP;

const {
  getChecklist,
  runReproCheck,
  recordResult,
  listChecks,
  exportReport,
} = await import("../lib/reproducibility.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("getChecklist returns the built-in checks", () => {
  const list = getChecklist();
  const ids = list.map((c) => c.id);
  assert.ok(ids.includes("data_available"));
  assert.ok(ids.includes("code_available"));
  assert.ok(ids.includes("seed_specified"));
  assert.ok(ids.includes("versions_pinned"));
  assert.ok(ids.includes("license_declared"));
});

test("runReproCheck rejects non-object subject", () => {
  assert.throws(() => runReproCheck(null));
});

test("runReproCheck passes a fully-specified subject", () => {
  const out = runReproCheck({
    dataset: { url: "https://example.com/data.zip" },
    codeUrl: "https://github.com/example/repo",
    seed: 42,
    dependencies: { numpy: "1.24.0", torch: "2.0.0" },
    hardware: { gpu: "A100", ram: "40GB" },
    license: "MIT",
  });
  assert.equal(out.passed, out.total);
  assert.equal(out.failed, 0);
  assert.equal(out.score, 100);
});

test("runReproCheck flags missing seed and data", () => {
  const out = runReproCheck({
    codeUrl: "https://example.com",
    license: "Apache-2.0",
  });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(byId.data_available.pass, false);
  assert.equal(byId.seed_specified.pass, false);
  assert.equal(byId.license_declared.pass, true);
  assert.ok(out.failed >= 2);
});

test("runReproCheck detects loose version pins", () => {
  const out = runReproCheck({
    dependencies: { numpy: "^1.24.0", torch: "~2.0" },
  });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(byId.versions_pinned.pass, false);
});

test("runReproCheck accepts pinned versions", () => {
  const out = runReproCheck({ dependencies: { numpy: "1.24.0" } });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(byId.versions_pinned.pass, true);
});

test("runReproCheck accepts seed on nested config", () => {
  const out = runReproCheck({ config: { seed: 123 } });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(byId.seed_specified.pass, true);
});

test("recordResult persists a result", async () => {
  const rec = await recordResult({
    subjectName: "example paper",
    passed: 4,
    failed: 2,
    total: 6,
    score: 66.67,
    results: [{ id: "data_available", pass: true }],
  });
  assert.ok(rec.id);
  assert.ok(rec.createdAt);
});

test("recordResult rejects invalid input", async () => {
  await assert.rejects(() => recordResult(null));
});

test("listChecks returns persisted results", async () => {
  const list = await listChecks();
  assert.ok(list.length >= 1);
});

test("exportReport json", async () => {
  const out = await exportReport("json");
  assert.ok(out.count >= 1);
  assert.ok(Array.isArray(out.results));
});

test("exportReport markdown", async () => {
  const out = await exportReport("markdown");
  assert.ok(typeof out === "string");
  assert.ok(out.startsWith("# Reproducibility Report"));
});

test("runReproCheck hardware check detects empty", () => {
  const out = runReproCheck({});
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  assert.equal(byId.hardware_described.pass, false);
});
