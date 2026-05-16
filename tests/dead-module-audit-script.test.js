import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/dead-module-audit.mjs");

test("dead-module-audit runs and reports a module count", () => {
  const res = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Dead-module audit: \d+ top-level lib modules scanned/);
});

test("dead-module-audit does not flag a known-imported module", () => {
  const res = spawnSync(process.execPath, [script], { encoding: "utf8" });
  // agent-loop.js is imported widely; it must never appear as an orphan.
  assert.doesNotMatch(res.stdout, /- lib\/agent-loop\.js/);
});

test("dead-module-audit honours DEAD_MODULE_STRICT", () => {
  const res = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, DEAD_MODULE_STRICT: "1" },
  });
  if (/ORPHANS \(\d+\)/.test(res.stdout)) {
    assert.notEqual(res.status, 0);
  } else {
    assert.equal(res.status, 0);
  }
});
