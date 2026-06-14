/**
 * Client CSS polish checks for mobile and touch ergonomics.
 * Pure regex-based unit tests — no DOM, no PostCSS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, "..");

const VIEWS = [
  "client/src/views/chat.css",
  "client/src/views/runs.css",
  "client/src/views/knowledge.css",
  "client/src/views/agent-run.css",
  "client/src/views/recipes.css",
  "client/src/views/replay.css",
  "client/src/views/observability.css",
];

function load(rel) {
  return readFileSync(resolve(repo, rel), "utf8");
}

function hasMaxWidthMedia(css) {
  return /@media\s*\([^)]*max-width\s*:\s*\d+/i.test(css);
}

function hasTouchTarget(css) {
  return /min-height\s*:\s*44px/.test(css);
}

for (const view of VIEWS) {
  test(`${view}: declares at least one max-width media query`, () => {
    assert.ok(hasMaxWidthMedia(load(view)), `expected @media (max-width:...) in ${view}`);
  });

  test(`${view}: includes min-height: 44px for touch targets`, () => {
    assert.ok(hasTouchTarget(load(view)), `expected min-height: 44px in ${view}`);
  });
}

test("chat.css: declares safe-area-inset-bottom for composer footer", () => {
  assert.match(load("client/src/views/chat.css"), /safe-area-inset-bottom/);
});

test("agent-run.css: declares safe-area-inset-bottom for run footer", () => {
  assert.match(load("client/src/views/agent-run.css"), /safe-area-inset-bottom/);
});
