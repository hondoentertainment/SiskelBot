/**
 * Phase 63.3: Test generation tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-test-gen-"));
process.env.STORAGE_PATH = TMP;

const {
  analyzeCoverage,
  listGaps,
  parseSignature,
  getSuggestedFixtures,
  generateTestScaffold,
  recordGeneratedTest,
} = await import("../lib/test-generation.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("parseSignature handles 'function name(a, b)'", () => {
  const p = parseSignature("function compute(a, b)");
  assert.equal(p.name, "compute");
  assert.deepEqual(p.params, ["a", "b"]);
});

test("parseSignature handles bare 'name(a, b)'", () => {
  const p = parseSignature("sum(x, y, z)");
  assert.equal(p.name, "sum");
  assert.deepEqual(p.params, ["x", "y", "z"]);
});

test("parseSignature returns null for bogus input", () => {
  assert.equal(parseSignature("no parens"), null);
  assert.equal(parseSignature(null), null);
});

test("getSuggestedFixtures infers from param names", () => {
  const fx = getSuggestedFixtures("process(count, name, items, isEnabled)");
  assert.equal(fx.count, 1);
  assert.equal(fx.name, "test");
  assert.deepEqual(fx.items, []);
  assert.equal(fx.isEnabled, true);
});

test("generateTestScaffold produces a node:test file", () => {
  const out = generateTestScaffold({
    signature: "function add(a, b)",
    modulePath: "../lib/math.js",
  });
  assert.equal(out.name, "add");
  assert.ok(out.code.includes('import test from "node:test"'));
  assert.ok(out.code.includes('import { add }'));
  assert.ok(out.code.includes('add('));
});

test("generateTestScaffold rejects invalid input", () => {
  assert.throws(() => generateTestScaffold({}));
  assert.throws(() => generateTestScaffold({ signature: "bad bad" }));
});

test("analyzeCoverage ranks gaps by coverage percent", async () => {
  const gaps = await analyzeCoverage({
    files: [
      { path: "a.js", lines: 100, covered: 90 },
      { path: "b.js", lines: 100, covered: 10 },
      { path: "c.js", lines: 100, covered: 60 },
    ],
  });
  assert.equal(gaps.length, 3);
  assert.equal(gaps[0].path, "b.js");
  assert.equal(gaps[0].severity, "high");
});

test("analyzeCoverage rejects invalid input", async () => {
  await assert.rejects(() => analyzeCoverage(null));
});

test("listGaps returns persisted gap records", async () => {
  const gaps = await listGaps();
  assert.ok(gaps.length >= 3);
  for (const g of gaps) assert.ok(g.analyzedAt);
});

test("recordGeneratedTest persists a record", async () => {
  const rec = await recordGeneratedTest({ name: "add", modulePath: "../lib/math.js", signature: "add(a, b)" });
  assert.equal(rec.name, "add");
  assert.ok(rec.id);
  assert.ok(rec.createdAt);
});

test("recordGeneratedTest rejects invalid input", async () => {
  await assert.rejects(() => recordGeneratedTest(null));
  await assert.rejects(() => recordGeneratedTest({}));
});

test("analyzeCoverage tracks uncovered functions", async () => {
  const gaps = await analyzeCoverage({
    files: [
      {
        path: "x.js",
        lines: 50,
        covered: 20,
        functions: [
          { name: "helper", covered: false },
          { name: "main", covered: true },
        ],
      },
    ],
  });
  assert.equal(gaps[0].uncoveredFunctions.length, 1);
  assert.equal(gaps[0].uncoveredFunctions[0].name, "helper");
});
