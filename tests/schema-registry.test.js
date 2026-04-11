/**
 * Phase 61.5: schema-registry tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-schemareg-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerSchema,
  getSchema,
  listVersions,
  isCompatible,
  diffSchemas,
  compareVersions,
  parseVersion,
  extractFields,
  computeSchemaDiff,
} = await import("../lib/schema-registry.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("parseVersion and compareVersions", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("2"), [2, 0, 0]);
  assert.equal(parseVersion("bad"), null);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("extractFields reads properties and required", () => {
  const fields = extractFields({
    properties: {
      id: { type: "string" },
      age: { type: "integer" },
    },
    required: ["id"],
  });
  assert.equal(fields.id.required, true);
  assert.equal(fields.id.type, "string");
  assert.equal(fields.age.required, false);
});

test("registerSchema creates version 1.0.0 by default", async () => {
  const s = await registerSchema({
    name: "User",
    kind: "json-schema",
    schema: {
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  });
  assert.equal(s.version, "1.0.0");
  const v = await listVersions("User");
  assert.equal(v.length, 1);
});

test("registerSchema auto-bumps to next version", async () => {
  await registerSchema({
    name: "AutoBump",
    schema: { properties: { a: { type: "string" } } },
  });
  const s = await registerSchema({
    name: "AutoBump",
    schema: { properties: { a: { type: "string" }, b: { type: "integer" } } },
  });
  assert.equal(s.version, "1.0.1");
});

test("registerSchema rejects downgrade", async () => {
  await registerSchema({
    name: "NoDowngrade",
    version: "2.0.0",
    schema: { properties: { a: { type: "string" } } },
  });
  await assert.rejects(() => registerSchema({
    name: "NoDowngrade",
    version: "1.0.0",
    schema: { properties: { a: { type: "string" } } },
  }));
});

test("registerSchema rejects invalid kind or missing fields", async () => {
  await assert.rejects(() => registerSchema({ name: "X", kind: "bogus", schema: {} }));
  await assert.rejects(() => registerSchema({ schema: {} }));
  await assert.rejects(() => registerSchema({ name: "X" }));
});

test("getSchema returns latest or specific version", async () => {
  await registerSchema({
    name: "Order",
    version: "1.0.0",
    schema: { properties: { id: { type: "string" } } },
  });
  await registerSchema({
    name: "Order",
    version: "1.1.0",
    schema: { properties: { id: { type: "string" }, total: { type: "number" } } },
  });
  const latest = await getSchema("Order");
  assert.equal(latest.version, "1.1.0");
  const v1 = await getSchema("Order", "1.0.0");
  assert.equal(v1.version, "1.0.0");
  assert.equal(await getSchema("Order", "9.9.9"), null);
});

test("computeSchemaDiff detects added/removed/changed fields", () => {
  const before = { properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a"] };
  const after = { properties: { a: { type: "integer" }, c: { type: "boolean" } }, required: ["a", "c"] };
  const diff = computeSchemaDiff(before, after);
  assert.ok(diff.added.includes("c"));
  assert.ok(diff.removed.includes("b"));
  assert.ok(diff.changed.some((c) => c.name === "a"));
});

test("isCompatible passes when adding an optional field", async () => {
  await registerSchema({
    name: "Compat1",
    version: "1.0.0",
    schema: { properties: { id: { type: "string" } }, required: ["id"] },
  });
  const result = await isCompatible("Compat1", {
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id"],
  });
  assert.equal(result.compatible, true);
  assert.equal(result.breaking.length, 0);
});

test("isCompatible fails when adding a required field", async () => {
  await registerSchema({
    name: "Compat2",
    version: "1.0.0",
    schema: { properties: { id: { type: "string" } }, required: ["id"] },
  });
  const result = await isCompatible("Compat2", {
    properties: { id: { type: "string" }, email: { type: "string" } },
    required: ["id", "email"],
  });
  assert.equal(result.compatible, false);
  assert.ok(result.breaking.some((b) => b.includes("email")));
});

test("isCompatible fails on type change", async () => {
  await registerSchema({
    name: "Compat3",
    version: "1.0.0",
    schema: { properties: { age: { type: "integer" } } },
  });
  const result = await isCompatible("Compat3", {
    properties: { age: { type: "string" } },
  });
  assert.equal(result.compatible, false);
  assert.ok(result.breaking.some((b) => b.includes("age")));
});

test("isCompatible returns compatible=true when no prior schema", async () => {
  const result = await isCompatible("BrandNew", {
    properties: { x: { type: "string" } },
  });
  assert.equal(result.compatible, true);
  assert.equal(result.breaking.length, 0);
});

test("diffSchemas diffs two versions of a registered schema", async () => {
  await registerSchema({
    name: "DiffSchema",
    version: "1.0.0",
    schema: { properties: { a: { type: "string" } } },
  });
  await registerSchema({
    name: "DiffSchema",
    version: "1.1.0",
    schema: { properties: { a: { type: "string" }, b: { type: "integer" } } },
  });
  const diff = await diffSchemas("DiffSchema", "1.0.0", "1.1.0");
  assert.equal(diff.fromVersion, "1.0.0");
  assert.equal(diff.toVersion, "1.1.0");
  assert.ok(diff.added.includes("b"));
});

test("diffSchemas accepts raw schema objects", async () => {
  const diff = await diffSchemas(
    { properties: { a: { type: "string" } } },
    { properties: { a: { type: "string" }, b: { type: "string" } } },
  );
  assert.ok(diff.added.includes("b"));
});

test("listVersions returns in insertion order", async () => {
  await registerSchema({ name: "OrderedVer", version: "1.0.0", schema: { properties: {} } });
  await registerSchema({ name: "OrderedVer", version: "1.0.1", schema: { properties: {} } });
  await registerSchema({ name: "OrderedVer", version: "1.1.0", schema: { properties: {} } });
  const versions = await listVersions("OrderedVer");
  assert.deepEqual(versions.map((v) => v.version), ["1.0.0", "1.0.1", "1.1.0"]);
});
