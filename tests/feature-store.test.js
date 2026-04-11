/**
 * Phase 57.5: Feature store tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-features-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerFeature,
  writeFeature,
  readFeature,
  listFeatures,
  batchReadFeatures,
  getOfflineHistory,
  deleteFeature,
} = await import("../lib/feature-store.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

/* -------------------------------------------------------------------------- */

test("registerFeature persists a spec with defaults", async () => {
  const f = await registerFeature({
    name: "user.age",
    type: "number",
    description: "user age in years",
    defaultValue: 0,
  });
  assert.equal(f.name, "user.age");
  assert.equal(f.type, "number");
  assert.equal(f.defaultValue, 0);
  assert.ok(f.ttlMs > 0);
});

test("registerFeature rejects invalid specs", async () => {
  await assert.rejects(() => registerFeature({}), /name required/);
  await assert.rejects(() => registerFeature({ name: "x", type: "bogus" }), /unknown feature type/);
  await assert.rejects(() => registerFeature(null), /required/);
});

test("writeFeature accepts values of the registered type", async () => {
  await registerFeature({ name: "user.email", type: "string" });
  const w = await writeFeature("user.email", "u1", "alice@example.com");
  assert.equal(w.value, "alice@example.com");
  await assert.rejects(() => writeFeature("user.email", "u1", 123), /does not match/);
});

test("writeFeature requires a registered feature", async () => {
  await assert.rejects(() => writeFeature("nope", "u1", "x"), /unknown feature/);
  await assert.rejects(() => writeFeature("", "u1", "x"), /required/);
});

test("readFeature returns written value and defaults for unknown entities", async () => {
  await writeFeature("user.age", "u1", 30);
  const r = await readFeature("user.age", "u1");
  assert.equal(r.value, 30);
  assert.equal(r.fresh, true);
  const r2 = await readFeature("user.age", "missing");
  assert.equal(r2.value, 0); // default
  assert.equal(r2.fresh, false);
});

test("readFeature honors TTL and returns default on expiry", async () => {
  await registerFeature({ name: "short", type: "number", ttlMs: 1, defaultValue: -1 });
  await writeFeature("short", "u1", 99);
  // Wait for expiry via a write with an old timestamp
  const old = new Date(Date.now() - 1000).toISOString();
  await writeFeature("short", "u1", 99, { timestamp: old });
  const r = await readFeature("short", "u1");
  assert.equal(r.expired, true);
  assert.equal(r.value, -1);
  // allowStale returns the actual value even if expired
  const r2 = await readFeature("short", "u1", { allowStale: true });
  assert.equal(r2.value, 99);
});

test("listFeatures returns all registered features", async () => {
  const list = await listFeatures();
  const names = list.map((f) => f.name);
  assert.ok(names.includes("user.age"));
  assert.ok(names.includes("user.email"));
});

test("batchReadFeatures fetches multiple features in one call", async () => {
  await writeFeature("user.email", "u1", "hi@example.com");
  const out = await batchReadFeatures(["user.age", "user.email", "missing"], "u1");
  assert.equal(out["user.age"].value, 30);
  assert.equal(out["user.email"].value, "hi@example.com");
  assert.ok(out["missing"].error);
});

test("batchReadFeatures rejects invalid input", async () => {
  await assert.rejects(() => batchReadFeatures(null, "u1"), /names array required/);
  await assert.rejects(() => batchReadFeatures(["x"], ""), /entityId required/);
});

test("getOfflineHistory preserves every write", async () => {
  await registerFeature({ name: "hist.v", type: "number" });
  await writeFeature("hist.v", "u1", 1);
  await writeFeature("hist.v", "u1", 2);
  await writeFeature("hist.v", "u1", 3);
  const history = await getOfflineHistory("hist.v", "u1");
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((h) => h.value), [1, 2, 3]);
});

test("deleteFeature wipes registration and data", async () => {
  const ok = await deleteFeature("hist.v");
  assert.equal(ok, true);
  await assert.rejects(() => readFeature("hist.v", "u1"), /unknown feature/);
  const none = await deleteFeature("hist.v");
  assert.equal(none, false);
});

test("feature types: array and object round-trip", async () => {
  await registerFeature({ name: "tags", type: "array" });
  await writeFeature("tags", "u1", ["a", "b"]);
  const r = await readFeature("tags", "u1");
  assert.deepEqual(r.value, ["a", "b"]);
  await registerFeature({ name: "profile", type: "object" });
  await writeFeature("profile", "u1", { name: "Alice" });
  const r2 = await readFeature("profile", "u1");
  assert.deepEqual(r2.value, { name: "Alice" });
});
