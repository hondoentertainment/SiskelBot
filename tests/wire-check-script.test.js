import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

test("wire-check script runs and reports route counts", () => {
  const res = spawnSync(
    process.execPath,
    [join(root, "scripts/wire-check.mjs")],
    { encoding: "utf8" }
  );
  assert.match(res.stdout, /Wire-check: \d+ route modules/);
});

test("wire-check script honours WIRE_CHECK_STRICT for untested routes", () => {
  const res = spawnSync(
    process.execPath,
    [join(root, "scripts/wire-check.mjs")],
    { encoding: "utf8", env: { ...process.env, WIRE_CHECK_STRICT: "1" } }
  );
  if (/MOUNTED but no test/.test(res.stdout)) {
    assert.notEqual(res.status, 0);
  }
});
