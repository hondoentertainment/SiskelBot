/**
 * Phase 53.5: Schema validation + repair tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-schema-repair-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  validateArgs,
  repairArgs,
  diffArgs,
  suggestFixes,
  recordRepairEvent,
  getRepairStats,
} = await import("../lib/schema-repair.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */
/* validateArgs                                                               */
/* -------------------------------------------------------------------------- */

test("validateArgs passes for well-formed args", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
  };
  const r = validateArgs(schema, { name: "Ada", age: 30 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test("validateArgs reports missing required", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  const r = validateArgs(schema, {});
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "REQUIRED"));
});

test("validateArgs flags wrong types", () => {
  const r = validateArgs({ type: "integer" }, "abc");
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "INVALID_TYPE");
});

test("validateArgs checks enum", () => {
  const schema = { type: "string", enum: ["a", "b", "c"] };
  assert.equal(validateArgs(schema, "a").ok, true);
  assert.equal(validateArgs(schema, "z").ok, false);
});

test("validateArgs checks minimum / maximum", () => {
  const schema = { type: "number", minimum: 1, maximum: 10 };
  assert.equal(validateArgs(schema, 5).ok, true);
  assert.equal(validateArgs(schema, 0).ok, false);
  assert.equal(validateArgs(schema, 99).ok, false);
});

test("validateArgs checks string bounds + pattern", () => {
  const schema = { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" };
  assert.equal(validateArgs(schema, "abc").ok, true);
  assert.equal(validateArgs(schema, "a").ok, false);
  assert.equal(validateArgs(schema, "abcdef").ok, false);
  assert.equal(validateArgs(schema, "A").ok, false);
});

test("validateArgs flags additionalProperties:false", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  assert.equal(validateArgs(schema, { a: "x", b: "y" }).ok, false);
});

test("validateArgs validates nested arrays", () => {
  const schema = { type: "array", items: { type: "integer" } };
  assert.equal(validateArgs(schema, [1, 2, 3]).ok, true);
  assert.equal(validateArgs(schema, [1, "two", 3]).ok, false);
});

/* -------------------------------------------------------------------------- */
/* repairArgs                                                                 */
/* -------------------------------------------------------------------------- */

test("repairArgs applies defaults to missing required props", () => {
  const schema = {
    type: "object",
    properties: {
      mode: { type: "string", default: "auto" },
      count: { type: "integer", default: 1 },
    },
    required: ["mode", "count"],
  };
  const r = repairArgs(schema, {});
  assert.equal(r.args.mode, "auto");
  assert.equal(r.args.count, 1);
  assert.ok(r.repairs.some((p) => p.kind === "default_applied"));
  assert.deepEqual(r.remainingErrors, []);
});

test("repairArgs coerces string -> number", () => {
  const schema = { type: "integer" };
  const r = repairArgs(schema, "42");
  assert.equal(r.args, 42);
  assert.ok(r.repairs.some((p) => p.kind === "coerced_to_number"));
});

test("repairArgs coerces string -> boolean", () => {
  const schema = { type: "boolean" };
  assert.equal(repairArgs(schema, "true").args, true);
  assert.equal(repairArgs(schema, "no").args, false);
});

test("repairArgs fuzzy-matches enums", () => {
  const schema = { type: "string", enum: ["production", "staging", "development"] };
  const r = repairArgs(schema, "prod");
  assert.equal(r.args, "production");
  assert.ok(r.repairs.some((p) => p.kind === "enum_fuzzy_matched"));
});

test("repairArgs trims whitespace and clamps numbers", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "integer", minimum: 1, maximum: 10 },
    },
  };
  const r = repairArgs(schema, { name: "  alice  ", count: 99 });
  assert.equal(r.args.name, "alice");
  assert.equal(r.args.count, 10);
});

test("repairArgs strips unknown properties under additionalProperties:false", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "string" } },
    additionalProperties: false,
  };
  const r = repairArgs(schema, { a: "x", b: "ignore me" });
  assert.equal(r.args.a, "x");
  assert.ok(!("b" in r.args));
});

test("repairArgs wraps scalar into array when schema expects array", () => {
  const schema = { type: "array", items: { type: "string" } };
  const r = repairArgs(schema, "single");
  assert.deepEqual(r.args, ["single"]);
});

test("repairArgs leaves valid input untouched", () => {
  const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const input = { a: "hello" };
  const r = repairArgs(schema, input);
  assert.deepEqual(r.args, { a: "hello" });
  assert.equal(r.repairs.length, 0);
  // No mutation of original.
  assert.notEqual(r.args, input);
});

/* -------------------------------------------------------------------------- */
/* diffArgs                                                                   */
/* -------------------------------------------------------------------------- */

test("diffArgs lists per-path differences", () => {
  const diffs = diffArgs({ a: 1, b: "x", c: { d: 1 } }, { a: 2, b: "x", c: { d: 2 } });
  const paths = diffs.map((d) => d.path).sort();
  assert.deepEqual(paths, ["/a", "/c/d"]);
});

test("diffArgs returns empty for identical input", () => {
  assert.deepEqual(diffArgs({ a: 1 }, { a: 1 }), []);
});

test("diffArgs handles array differences", () => {
  const diffs = diffArgs([1, 2, 3], [1, 2, 4]);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].before, 3);
  assert.equal(diffs[0].after, 4);
});

/* -------------------------------------------------------------------------- */
/* suggestFixes                                                               */
/* -------------------------------------------------------------------------- */

test("suggestFixes returns plain-English hints", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
  };
  const hints = suggestFixes(schema, { age: "thirty" });
  assert.ok(hints.some((h) => h.includes("Add required field")));
  assert.ok(hints.some((h) => h.includes("Change")));
});

/* -------------------------------------------------------------------------- */
/* stats persistence                                                          */
/* -------------------------------------------------------------------------- */

test("recordRepairEvent persists stats", async () => {
  await recordRepairEvent("my_tool", { repaired: 3, errors: 1 });
  await recordRepairEvent("my_tool", { repaired: 1, errors: 0 });
  const stats = await getRepairStats("my_tool");
  assert.equal(stats.validations, 2);
  assert.equal(stats.repairs, 4);
  assert.equal(stats.errors, 1);
});
