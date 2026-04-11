/**
 * Phase 63.4: Refactoring tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-refactoring-"));
process.env.STORAGE_PATH = TMP;

const {
  renameSymbol,
  extractFunction,
  inlineVariable,
  planRefactor,
  previewRefactor,
  applyRefactor,
  listRefactors,
  rollbackRefactor,
} = await import("../lib/refactoring.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("renameSymbol replaces whole words only", () => {
  const out = renameSymbol("const foo = 1; const foobar = foo + 1;", "foo", "bar");
  assert.ok(out.includes("bar = 1"));
  assert.ok(out.includes("foobar")); // foobar untouched
  assert.ok(out.includes("bar + 1"));
});

test("renameSymbol handles empty input", () => {
  assert.equal(renameSymbol("", "a", "b"), "");
  assert.equal(renameSymbol("text", "", "b"), "text");
});

test("extractFunction wraps a line range", () => {
  const text = "line1\nline2\nline3\nline4";
  const out = extractFunction(text, 2, 3, "helper");
  assert.ok(out.includes("function helper()"));
  assert.ok(out.includes("line2"));
  assert.ok(out.includes("line3"));
  assert.ok(out.includes("helper();"));
});

test("inlineVariable substitutes subsequent references", () => {
  const text = "const x = 2 + 3;\nconsole.log(x);\nconsole.log(x);";
  const out = inlineVariable(text, "x");
  assert.ok(!out.includes("const x"));
  assert.ok(out.includes("(2 + 3)"));
});

test("inlineVariable returns text unchanged if declaration missing", () => {
  const text = "no declarations here";
  assert.equal(inlineVariable(text, "missing"), text);
});

test("planRefactor persists a plan", async () => {
  const plan = await planRefactor({
    op: "rename",
    oldName: "foo",
    newName: "bar",
    file: "src/a.js",
  });
  assert.ok(plan.id);
  assert.equal(plan.op, "rename");
  assert.equal(plan.status, "planned");
});

test("planRefactor rejects invalid op", async () => {
  await assert.rejects(() => planRefactor({ op: "unknown" }));
  await assert.rejects(() => planRefactor(null));
});

test("previewRefactor returns transformed files without saving", async () => {
  const plan = await planRefactor({ op: "rename", oldName: "x", newName: "y" });
  const result = await previewRefactor(plan.id, { "a.js": "const x = 1; console.log(x);" });
  assert.ok(result.files["a.js"].includes("const y"));
  // Plan should still be "planned"
  const all = await listRefactors();
  const me = all.find((p) => p.id === plan.id);
  assert.equal(me.status, "planned");
});

test("applyRefactor persists originals and marks applied", async () => {
  const plan = await planRefactor({ op: "rename", oldName: "foo", newName: "bar" });
  const out = await applyRefactor(plan.id, { "a.js": "const foo = 1;" });
  assert.ok(out.files["a.js"].includes("const bar"));
  assert.equal(out.plan.status, "applied");
});

test("rollbackRefactor restores originals", async () => {
  const plan = await planRefactor({ op: "rename", oldName: "a", newName: "b" });
  const original = { "f.js": "const a = 1; a + 1;" };
  await applyRefactor(plan.id, original);
  const restored = await rollbackRefactor(plan.id);
  assert.deepEqual(restored, original);
});

test("rollbackRefactor rejects on non-applied plans", async () => {
  const plan = await planRefactor({ op: "rename", oldName: "a", newName: "b" });
  await assert.rejects(() => rollbackRefactor(plan.id));
});

test("listRefactors returns persisted plans", async () => {
  const all = await listRefactors();
  assert.ok(all.length >= 3);
});

test("previewRefactor rejects unknown id", async () => {
  await assert.rejects(() => previewRefactor("unknown", { "a.js": "x" }));
});

test("applyRefactor supports inline_variable op", async () => {
  const plan = await planRefactor({ op: "inline_variable", variable: "sum" });
  const out = await applyRefactor(plan.id, { "b.js": "const sum = 1 + 2;\nconsole.log(sum);" });
  assert.ok(out.files["b.js"].includes("(1 + 2)"));
});
