/**
 * Phase 57.3: Schema evolution tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-schema-"));
process.env.STORAGE_PATH = TMP;

const {
  COMPATIBILITY_MODES,
  registerSchema,
  getSchema,
  listVersions,
  listSubjects,
  setCompatibility,
  checkCompatibility,
  _reset,
} = await import("../lib/schema-evolution.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("COMPATIBILITY_MODES lists backward/forward/full/none", () => {
  assert.deepEqual([...COMPATIBILITY_MODES], ["backward", "forward", "full", "none"]);
});

test("registerSchema v1 records version 1", async () => {
  await _reset();
  const result = await registerSchema("user", {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" } },
    required: ["id"],
  });
  assert.equal(result.version, 1);
});

test("registerSchema bumps the version on each compatible change", async () => {
  await _reset();
  await registerSchema("user", {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  });
  // Adding an optional field is backward compatible.
  const v2 = await registerSchema("user", {
    type: "object",
    properties: { id: { type: "string" }, age: { type: "number" } },
    required: ["id"],
  });
  assert.equal(v2.version, 2);
});

test("registerSchema rejects incompatible change under backward mode", async () => {
  await _reset();
  await registerSchema("order", {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  }, { compatibility: "backward" });
  await assert.rejects(
    () => registerSchema("order", {
      type: "object",
      properties: { id: { type: "string" }, total: { type: "number" } },
      required: ["id", "total"],
    }),
    /incompatible/i,
  );
});

test("registerSchema allows breaking changes under 'none'", async () => {
  await _reset();
  await registerSchema("free", {
    type: "object",
    properties: { a: { type: "string" } },
  }, { compatibility: "none" });
  const v2 = await registerSchema("free", {
    type: "object",
    properties: { a: { type: "number" } }, // type changed
  });
  assert.equal(v2.version, 2);
});

test("getSchema returns the latest or a specific version", async () => {
  await _reset();
  await registerSchema("acct", { type: "object", properties: { id: { type: "string" } }, required: ["id"] });
  await registerSchema("acct", { type: "object", properties: { id: { type: "string" }, nick: { type: "string" } }, required: ["id"] });
  const latest = await getSchema("acct");
  assert.equal(latest.version, 2);
  const v1 = await getSchema("acct", 1);
  assert.equal(v1.version, 1);
  assert.ok(!("nick" in v1.schema.properties));
});

test("listVersions returns all version metadata", async () => {
  await _reset();
  await registerSchema("multi", { type: "object", properties: { a: { type: "string" } } });
  await registerSchema("multi", { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } });
  const versions = await listVersions("multi");
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, 1);
  assert.equal(versions[1].version, 2);
});

test("listSubjects returns registered subjects", async () => {
  await _reset();
  await registerSchema("s1", { type: "object" });
  await registerSchema("s2", { type: "object" });
  const subs = await listSubjects();
  assert.ok(subs.includes("s1"));
  assert.ok(subs.includes("s2"));
});

test("setCompatibility updates mode", async () => {
  await _reset();
  await registerSchema("mode", { type: "object" });
  const out = await setCompatibility("mode", "forward");
  assert.equal(out.compatibility, "forward");
});

test("checkCompatibility detects type changes under backward", () => {
  const oldS = { type: "object", properties: { x: { type: "string" } } };
  const newS = { type: "object", properties: { x: { type: "number" } } };
  const r = checkCompatibility(oldS, newS, "backward");
  assert.equal(r.compatible, false);
  assert.ok(r.issues.some((i) => /type change/.test(i)));
});

test("checkCompatibility detects removed required field under forward", () => {
  const oldS = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
  const newS = { type: "object", properties: {} };
  const r = checkCompatibility(oldS, newS, "forward");
  assert.equal(r.compatible, false);
  assert.ok(r.issues.some((i) => /removed/.test(i)));
});

test("checkCompatibility permits adding optional fields in backward", () => {
  const oldS = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
  const newS = { type: "object", properties: { x: { type: "string" }, y: { type: "number" } }, required: ["x"] };
  const r = checkCompatibility(oldS, newS, "backward");
  assert.equal(r.compatible, true);
});

test("checkCompatibility 'none' always returns compatible", () => {
  const a = { type: "object", properties: { x: { type: "string" } }, required: ["x"] };
  const b = { type: "object" };
  assert.equal(checkCompatibility(a, b, "none").compatible, true);
});
