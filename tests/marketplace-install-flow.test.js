/**
 * Pure-unit tests for the small helpers baked into client/marketplace.html.
 *
 * The helpers are trivial pure functions; we reproduce them here from the
 * HTML source-of-truth and cover the branches we rely on in the UI
 * (progress formatting, row-state derivation). No JSDOM required.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKETPLACE_HTML = join(__dirname, "..", "client", "marketplace.html");

// --- Reproductions of the helpers from marketplace.html -----------------
// Keep these in sync with the HTML file; a guard test below asserts that
// the HTML still exports these by name so a rename is caught in CI.

function formatProgress(p) {
  const n = Number(p);
  if (!isFinite(n) || n < 0) return "0%";
  if (n > 1) return "100%";
  return Math.round(n * 100) + "%";
}

function pluginRowState(state) {
  const s = state || {};
  if (!s.installed) return "available";
  if (s.enabled === false) return "disabled";
  return "enabled";
}

// --- formatProgress -----------------------------------------------------

test("formatProgress clamps NaN/negative to 0%", () => {
  assert.equal(formatProgress(undefined), "0%");
  assert.equal(formatProgress(null), "0%");
  assert.equal(formatProgress("not a number"), "0%");
  assert.equal(formatProgress(-1), "0%");
  assert.equal(formatProgress(-0.0001), "0%");
});

test("formatProgress clamps >1 to 100%", () => {
  assert.equal(formatProgress(1), "100%");
  assert.equal(formatProgress(1.25), "100%");
  assert.equal(formatProgress(42), "100%");
});

test("formatProgress rounds fractional values to nearest percent", () => {
  assert.equal(formatProgress(0), "0%");
  assert.equal(formatProgress(0.004), "0%");
  assert.equal(formatProgress(0.005), "1%");
  assert.equal(formatProgress(0.25), "25%");
  assert.equal(formatProgress(0.333), "33%");
  assert.equal(formatProgress(0.5), "50%");
  assert.equal(formatProgress(0.999), "100%");
});

test("formatProgress accepts numeric strings", () => {
  assert.equal(formatProgress("0.5"), "50%");
  assert.equal(formatProgress("0.75"), "75%");
});

// --- pluginRowState ------------------------------------------------------

test("pluginRowState: not installed -> available", () => {
  assert.equal(pluginRowState(undefined), "available");
  assert.equal(pluginRowState(null), "available");
  assert.equal(pluginRowState({}), "available");
  assert.equal(pluginRowState({ installed: false }), "available");
});

test("pluginRowState: installed + enabled !== false -> enabled", () => {
  assert.equal(pluginRowState({ installed: true }), "enabled");
  assert.equal(pluginRowState({ installed: true, enabled: true }), "enabled");
  // undefined/true -> treat as enabled per UI default
  assert.equal(pluginRowState({ installed: true, enabled: undefined }), "enabled");
});

test("pluginRowState: installed with enabled=false -> disabled", () => {
  assert.equal(pluginRowState({ installed: true, enabled: false }), "disabled");
});

// --- Source-of-truth guards ---------------------------------------------

test("marketplace.html still defines the expected helper names", () => {
  const src = readFileSync(MARKETPLACE_HTML, "utf8");
  assert.match(src, /function\s+formatProgress\b/, "expected formatProgress definition");
  assert.match(src, /function\s+pluginRowState\b/, "expected pluginRowState definition");
  assert.match(
    src,
    /window\.__marketplaceHelpers\s*=\s*\{\s*formatProgress\s*,\s*pluginRowState\s*\}/,
    "expected helpers to be exposed on window.__marketplaceHelpers"
  );
});

test("marketplace.html polls the polished job endpoint", () => {
  const src = readFileSync(MARKETPLACE_HTML, "utf8");
  assert.match(src, /\/api\/v1\/plugins\/jobs\//, "expected job-polling endpoint");
  assert.match(src, /\/api\/v1\/plugins\/[^/]+\/install/, "expected install endpoint");
  assert.match(src, /\/api\/v1\/plugins\/[^/]+\/enable/, "expected enable endpoint");
  assert.match(src, /\/api\/v1\/plugins\/[^/]+\/disable/, "expected disable endpoint");
});
