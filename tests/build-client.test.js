/**
 * Tests for scripts/build-client.mjs.
 *
 * Runs the build script as a child process in a non-watch mode and asserts
 * that the bundled entry for client/src/app.js lands at client/dist/app.js
 * with exit code 0. Cleans up client/dist/ afterwards.
 *
 * Skips cleanly when esbuild is not installed so this test does not fail in
 * minimal environments — the build script's fallback still produces a
 * dist/app.js, so the core assertion still holds, but we explicitly call out
 * the fallback path so failures are easier to diagnose.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const DIST_DIR = join(ROOT, "client", "dist");
const SCRIPT = join(ROOT, "scripts", "build-client.mjs");
const APP_SRC = join(ROOT, "client", "src", "app.js");

function hasEsbuild() {
  return existsSync(join(ROOT, "node_modules", "esbuild", "package.json"));
}

function cleanDist() {
  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { recursive: true, force: true });
  }
}

test("build-client.mjs produces client/dist/app.js", (t) => {
  if (!existsSync(SCRIPT)) {
    t.skip("scripts/build-client.mjs not present");
    return;
  }
  if (!existsSync(APP_SRC)) {
    t.skip("client/src/app.js not present — nothing to bundle");
    return;
  }

  cleanDist();
  t.after(() => cleanDist());

  const result = spawnSync(process.execPath, [SCRIPT, "--prod"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
    timeout: 60_000,
  });

  if (!hasEsbuild()) {
    // Fallback path: script still exits 0 and copies app.js through.
    assert.equal(
      result.status,
      0,
      `build script must exit 0 in fallback mode; stderr=${result.stderr}`,
    );
    const fallbackApp = join(DIST_DIR, "app.js");
    assert.ok(
      existsSync(fallbackApp),
      `expected ${fallbackApp} in fallback mode`,
    );
    return;
  }

  assert.equal(
    result.status,
    0,
    `build script must exit 0; stderr=${result.stderr}\nstdout=${result.stdout}`,
  );

  const appOut = join(DIST_DIR, "app.js");
  assert.ok(existsSync(appOut), `expected bundled ${appOut} to exist`);
  assert.ok(
    statSync(appOut).size > 0,
    "bundled app.js should not be empty",
  );

  const manifestPath = join(DIST_DIR, "manifest.json");
  assert.ok(existsSync(manifestPath), "expected manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.entries, "manifest.entries must be present");
  assert.ok(
    typeof manifest.entries.app === "string" && manifest.entries.app.length > 0,
    "manifest.entries.app must map to an output path",
  );
});
