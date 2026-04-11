/**
 * Phase 57.3: Schema evolution tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-schema-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerSchema,
  getSchemaVersion,
  migrateRecord,
  listSchemas,
  diffSchemas,
  latestVersion,
  _registerMigration,
} = await import("../lib/schema-evolution.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("registerSchema persists v1 and getSchemaVersion returns it", async () => {
  const v1 = await registerSchema("user", 1, {
    fields: {
      id: { type: "string", required: true },
      name: { type: "string", required: true },
    },
    description: "initial user schema",
  });
  assert.equal(v1.version, 1);
  const fetched = await getSchemaVersion("user", 1);
  assert.ok(fetched);
  assert.equal(fetched.description, "initial user schema");
  assert.equal(await latestVersion("user"), 1);
});

test("registerSchema rejects duplicate version and gap", async () => {
  await assert.rejects(() => registerSchema("user", 1, { fields: { a: { type: "string" } } }), /already has/);
  await assert.rejects(() => registerSchema("user", 3, { fields: { a: { type: "string" } } }), /cannot register/);
});

test("registerSchema rejects invalid input", async () => {
  await assert.rejects(() => registerSchema("", 1, { fields: {} }), /required/);
  await assert.rejects(() => registerSchema("x", 1, null), /fields required/);
  await assert.rejects(() => registerSchema("x", 0, { fields: {} }), /version must be/);
});

test("registerSchema v2 chains automatically", async () => {
  await registerSchema("user", 2, {
    fields: {
      id: { type: "string", required: true },
      name: { type: "string", required: true },
      email: { type: "string", required: false, default: "" },
    },
  });
  assert.equal(await latestVersion("user"), 2);
});

test("getSchemaVersion returns latest when no version given", async () => {
  const latest = await getSchemaVersion("user");
  assert.equal(latest.version, 2);
  assert.ok(latest.fields.email);
  assert.equal(await getSchemaVersion("user", 99), null);
  assert.equal(await getSchemaVersion("nope"), null);
});

test("migrateRecord auto-migrates v1 records to latest", async () => {
  const rec = { id: "u1", name: "Alice", _schemaVersion: 1 };
  const migrated = await migrateRecord("user", rec);
  assert.equal(migrated._schemaVersion, 2);
  assert.equal(migrated.email, "");
  assert.equal(migrated.name, "Alice");
});

test("migrateRecord uses a custom migration when provided", async () => {
  await registerSchema("post", 1, { fields: { title: { type: "string" } } });
  await registerSchema("post", 2, {
    fields: {
      title: { type: "string" },
      slug: { type: "string", default: "" },
    },
  }, (rec) => ({ ...rec, slug: String(rec.title || "").toLowerCase().replace(/\s+/g, "-") }));
  const migrated = await migrateRecord("post", { title: "Hello World", _schemaVersion: 1 });
  assert.equal(migrated.slug, "hello-world");
  assert.equal(migrated._schemaVersion, 2);
});

test("migrateRecord rejects unknown schema / source version", async () => {
  await assert.rejects(() => migrateRecord("missing", {}), /no schema/);
  await assert.rejects(() => migrateRecord("user", { _schemaVersion: 99 }), /unknown source version/);
  await assert.rejects(() => migrateRecord("user", null), /record required/);
});

test("listSchemas reports latest versions", async () => {
  const list = await listSchemas();
  const user = list.find((s) => s.name === "user");
  assert.ok(user);
  assert.equal(user.latest, 2);
  assert.ok(user.versionCount >= 2);
});

test("diffSchemas returns added / removed / changed", async () => {
  await registerSchema("item", 1, {
    fields: {
      id: { type: "string", required: true },
      price: { type: "number", required: true },
      tag: { type: "string" },
    },
  });
  await registerSchema("item", 2, {
    fields: {
      id: { type: "string", required: true },
      price: { type: "number", required: false }, // required changed
      label: { type: "string" }, // added
    },
  });
  const diff = await diffSchemas("item", 1, 2);
  assert.deepEqual(diff.added, ["label"]);
  assert.deepEqual(diff.removed, ["tag"]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].field, "price");
});

test("diffSchemas rejects unknown versions", async () => {
  await assert.rejects(() => diffSchemas("item", 1, 99), /no version 99/);
  await assert.rejects(() => diffSchemas("missing", 1, 2), /no schema/);
});

test("_registerMigration can patch migrations in-place", async () => {
  await registerSchema("audit", 1, { fields: { msg: { type: "string" } } });
  await registerSchema("audit", 2, { fields: { msg: { type: "string" }, ts: { type: "string" } } });
  _registerMigration("audit", 2, (rec) => ({ ...rec, ts: "patched" }));
  const out = await migrateRecord("audit", { msg: "hi", _schemaVersion: 1 });
  assert.equal(out.ts, "patched");
});
