/**
 * Phase 57.5: Feature store tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-feature-store-"));
process.env.STORAGE_PATH = TMP;

const {
  FEATURE_TYPES,
  defineFeature,
  writeFeature,
  readFeature,
  batchRead,
  listFeatures,
  readOffline,
  _reset,
} = await import("../lib/feature-store.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("FEATURE_TYPES exposes core types", () => {
  for (const t of ["numeric", "categorical", "boolean", "string", "vector"]) {
    assert.ok(FEATURE_TYPES.includes(t));
  }
});

test("defineFeature validates name and type", async () => {
  await _reset();
  await assert.rejects(() => defineFeature({}), /name is required/);
  await assert.rejects(() => defineFeature({ name: "x", type: "bogus" }), /type must be/);
});

test("defineFeature persists a feature", async () => {
  await _reset();
  const rec = await defineFeature({ name: "user_age", type: "numeric", ttlMs: 60_000 });
  assert.equal(rec.name, "user_age");
  assert.equal(rec.type, "numeric");
  assert.equal(rec.ttlMs, 60_000);
});

test("writeFeature validates value type", async () => {
  await _reset();
  await defineFeature({ name: "score", type: "numeric" });
  await assert.rejects(() => writeFeature("score", "u1", "not-a-number"), /does not match/);
  await assert.rejects(() => writeFeature("score", "u1", NaN), /does not match/);
});

test("writeFeature then readFeature returns the value", async () => {
  await _reset();
  await defineFeature({ name: "score", type: "numeric" });
  await writeFeature("score", "user-1", 42);
  const rec = await readFeature("score", "user-1");
  assert.equal(rec.value, 42);
  assert.equal(rec.entity, "user-1");
});

test("readFeature returns null after TTL expiry", async () => {
  await _reset();
  await defineFeature({ name: "fresh", type: "numeric", ttlMs: 1 });
  await writeFeature("fresh", "e1", 1, { timestamp: 1000 });
  const ok = await readFeature("fresh", "e1", { now: 1000 });
  assert.equal(ok.value, 1);
  const stale = await readFeature("fresh", "e1", { now: 2000 });
  assert.equal(stale, null);
});

test("readFeature returns null for unknown entity", async () => {
  await _reset();
  await defineFeature({ name: "z", type: "numeric" });
  const rec = await readFeature("z", "missing");
  assert.equal(rec, null);
});

test("batchRead reads multiple features + entities", async () => {
  await _reset();
  await defineFeature({ name: "a", type: "numeric" });
  await defineFeature({ name: "b", type: "string" });
  await writeFeature("a", "e1", 1);
  await writeFeature("b", "e1", "hello");
  const results = await batchRead([
    { feature: "a", entity: "e1" },
    { feature: "b", entity: "e1" },
    { feature: "a", entity: "missing" },
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0].value, 1);
  assert.equal(results[1].value, "hello");
  assert.equal(results[2], null);
});

test("listFeatures returns all defined features", async () => {
  await _reset();
  await defineFeature({ name: "f1", type: "numeric" });
  await defineFeature({ name: "f2", type: "string" });
  const list = await listFeatures();
  assert.ok(list.length >= 2);
  assert.ok(list.some((f) => f.name === "f1"));
  assert.ok(list.some((f) => f.name === "f2"));
});

test("writeFeature appends to offline log (unless opted out)", async () => {
  await _reset();
  await defineFeature({ name: "log-feat", type: "numeric" });
  await writeFeature("log-feat", "e", 1);
  await writeFeature("log-feat", "e", 2);
  await writeFeature("log-feat", "e", 3, { offline: false });
  const log = await readOffline("log-feat");
  assert.equal(log.length, 2);
  assert.equal(log[0].value, 1);
  assert.equal(log[1].value, 2);
});

test("readOffline supports time filters", async () => {
  await _reset();
  await defineFeature({ name: "ts-feat", type: "numeric" });
  await writeFeature("ts-feat", "e", 1, { timestamp: 1000 });
  await writeFeature("ts-feat", "e", 2, { timestamp: 2000 });
  await writeFeature("ts-feat", "e", 3, { timestamp: 3000 });
  const mid = await readOffline("ts-feat", { since: 1500, until: 2500 });
  assert.equal(mid.length, 1);
  assert.equal(mid[0].value, 2);
});

test("vector feature accepts numeric arrays only", async () => {
  await _reset();
  await defineFeature({ name: "embed", type: "vector" });
  await writeFeature("embed", "e", [1, 2, 3]);
  await assert.rejects(() => writeFeature("embed", "e", ["x"]), /does not match/);
});
