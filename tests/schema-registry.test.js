/**
 * Phase 61.5: Schema registry tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-schema-registry-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerSchema,
  getSchema,
  listVersions,
  diffSchemas,
} = await import("../lib/schema-registry.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("registerSchema rejects missing fields", async () => {
  await assert.rejects(() => registerSchema({}), /namespace is required/);
  await assert.rejects(() => registerSchema({ namespace: "openapi" }), /id is required/);
  await assert.rejects(() => registerSchema({ namespace: "openapi", id: "x" }), /version is required/);
  await assert.rejects(
    () => registerSchema({ namespace: "openapi", id: "x", version: "1" }),
    /schema must be an object/,
  );
});

test("registerSchema stores and getSchema retrieves", async () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const rec = await registerSchema({ namespace: "openapi", id: "user", version: "1.0.0", schema });
  assert.equal(rec.version, "1.0.0");
  assert.ok(rec.hash);
  const fetched = await getSchema("openapi", "user", "1.0.0");
  assert.deepEqual(fetched.schema, schema);
});

test("registerSchema is idempotent for identical payload", async () => {
  const schema = { type: "object" };
  const first = await registerSchema({ namespace: "event", id: "ping", version: "1", schema });
  const second = await registerSchema({ namespace: "event", id: "ping", version: "1", schema });
  assert.equal(first.hash, second.hash);
});

test("registerSchema rejects conflicting content for same version", async () => {
  await registerSchema({
    namespace: "event",
    id: "conflict",
    version: "1",
    schema: { type: "object" },
  });
  await assert.rejects(
    () => registerSchema({
      namespace: "event",
      id: "conflict",
      version: "1",
      schema: { type: "object", additionalProperties: false },
    }),
    (err) => err.code === "ALREADY_EXISTS",
  );
});

test("listVersions returns all registered versions in registration order", async () => {
  await registerSchema({ namespace: "api", id: "thing", version: "1.0.0", schema: { v: 1 } });
  await registerSchema({ namespace: "api", id: "thing", version: "1.1.0", schema: { v: 2 } });
  await registerSchema({ namespace: "api", id: "thing", version: "2.0.0", schema: { v: 3 } });
  const versions = await listVersions("api", "thing");
  assert.equal(versions.length, 3);
  assert.deepEqual(versions.map((v) => v.version), ["1.0.0", "1.1.0", "2.0.0"]);
});

test("getSchema with no version returns latest", async () => {
  await registerSchema({ namespace: "api", id: "latest", version: "1", schema: { v: 1 } });
  await registerSchema({ namespace: "api", id: "latest", version: "2", schema: { v: 2 } });
  const latest = await getSchema("api", "latest");
  assert.equal(latest.version, "2");
});

test("diffSchemas detects field removal as breaking", () => {
  const before = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
  const after = { type: "object", properties: { a: { type: "string" } } };
  const diff = diffSchemas(before, after);
  assert.equal(diff.breaking, true);
  assert.ok(diff.changes.some((c) => c.type === "removed"));
});

test("diffSchemas detects new optional fields as additive", () => {
  const before = { type: "object", properties: { a: { type: "string" } } };
  const after = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
  const diff = diffSchemas(before, after);
  assert.equal(diff.breaking, false);
  assert.ok(diff.changes.some((c) => c.type === "added"));
});

test("diffSchemas detects type changes as breaking", () => {
  const before = { type: "object", properties: { a: { type: "string" } } };
  const after = { type: "object", properties: { a: { type: "number" } } };
  const diff = diffSchemas(before, after);
  assert.equal(diff.breaking, true);
});

test("diffSchemas flags added required fields as breaking", () => {
  const before = { type: "object", required: ["a"], properties: { a: {} } };
  const after = { type: "object", required: ["a", "b"], properties: { a: {}, b: {} } };
  const diff = diffSchemas(before, after);
  assert.ok(diff.changes.some((c) => c.type === "required_added" && c.added === "b"));
  assert.equal(diff.breaking, true);
});

test("diffSchemas returns identical result for identical schemas", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } };
  const diff = diffSchemas(schema, schema);
  assert.equal(diff.changes.length, 0);
  assert.equal(diff.breaking, false);
});

test("getSchema returns null when unknown", async () => {
  const rec = await getSchema("nope", "nope", "0");
  assert.equal(rec, null);
});
