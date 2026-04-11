/**
 * Phase 63.5: Migration assistant tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-migration-"));
process.env.STORAGE_PATH = TMP;

const {
  listCodemods,
  applyCodemod,
  previewCodemod,
  getMigrationPlan,
  runMigration,
  listMigrations,
} = await import("../lib/migration-assistant.js");

test.after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

test("listCodemods returns built-in codemods", async () => {
  const mods = await listCodemods();
  const ids = mods.map((m) => m.id);
  assert.ok(ids.includes("var-to-const"));
  assert.ok(ids.includes("commonjs-to-esm-require"));
  assert.ok(ids.includes("commonjs-exports"));
});

test("applyCodemod var-to-const replaces var", async () => {
  const out = await applyCodemod("var-to-const", "var x = 1;");
  assert.ok(out.text.includes("const x ="));
  assert.equal(out.changes, 1);
});

test("applyCodemod require-to-import converts requires", async () => {
  const out = await applyCodemod(
    "commonjs-to-esm-require",
    'const fs = require("fs");',
  );
  assert.ok(out.text.includes("import fs from"));
});

test("applyCodemod rejects unknown id", async () => {
  await assert.rejects(() => applyCodemod("nonexistent", "text"));
});

test("applyCodemod rejects non-string text", async () => {
  await assert.rejects(() => applyCodemod("var-to-const", null));
});

test("previewCodemod applies across multiple files", async () => {
  const out = await previewCodemod("var-to-const", {
    "a.js": "var a = 1;",
    "b.js": "var b = 2; var c = 3;",
    "c.js": "no changes",
  });
  assert.equal(out.changes["a.js"], 1);
  assert.equal(out.changes["b.js"], 2);
  assert.equal(out.changes["c.js"], 0);
  assert.equal(out.total, 3);
});

test("previewCodemod rejects missing files", async () => {
  await assert.rejects(() => previewCodemod("var-to-const", null));
});

test("getMigrationPlan chains codemods in sequence", async () => {
  const plan = await getMigrationPlan(
    ["var-to-const", "commonjs-to-esm-require"],
    {
      "a.js": 'var fs = require("fs");\nvar path = require("path");',
    },
  );
  assert.equal(plan.steps.length, 2);
  assert.ok(plan.totalChanges >= 2);
  const final = plan.finalFiles["a.js"];
  assert.ok(final.includes("import fs from"));
});

test("getMigrationPlan rejects non-array codemodIds", async () => {
  await assert.rejects(() => getMigrationPlan(null, {}));
});

test("runMigration persists a migration record", async () => {
  const result = await runMigration(["var-to-const"], { "x.js": "var x = 1;" });
  assert.ok(result.id);
  assert.equal(result.totalChanges, 1);
  assert.ok(result.files["x.js"].includes("const x"));
  const list = await listMigrations();
  assert.ok(list.some((m) => m.id === result.id));
});

test("applyCodemod commonjs-exports converts module.exports", async () => {
  const out = await applyCodemod("commonjs-exports", "module.exports = {}");
  assert.ok(out.text.startsWith("export default"));
});

test("applyCodemod deprecated-assert-equal upgrades assert", async () => {
  const out = await applyCodemod("deprecated-assert-equal", "assert.equal(1, 1);");
  assert.ok(out.text.includes("assert.strictEqual"));
});
