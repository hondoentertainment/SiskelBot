/**
 * Unit tests for the pure helpers exported from
 * client/src/views/marketplace-view.js. No JSDOM required.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Minimal shim: ensureStylesheet() guards on `typeof document`, but the module
// also references `document` at module scope is avoided. Be safe anyway.
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({
      appendChild: () => {},
      addEventListener: () => {},
      setAttribute: () => {},
      dataset: {},
    }),
    head: { appendChild: () => {} },
  };
}

const {
  filterPlugins,
  sortByName,
  summarizeManifest,
  installButtonLabel,
  pluginRowState,
  formatProgress,
} = await import("../client/src/views/marketplace-view.js");

test("filterPlugins: empty/invalid input returns []", () => {
  assert.deepEqual(filterPlugins(null, {}), []);
  assert.deepEqual(filterPlugins(undefined, {}), []);
  assert.deepEqual(filterPlugins([], { query: "foo" }), []);
});

test("filterPlugins: case-insensitive match across name/description/author/category", () => {
  const packs = [
    { id: "a", name: "Alpha", description: "does foo", author: "Alice", category: "tools" },
    { id: "b", name: "Beta", description: "bar things", author: "Bob", category: "dev" },
    { id: "c", name: "Gamma", description: "other", author: "Foo User", category: "dev" },
  ];
  // Query hits description
  const r1 = filterPlugins(packs, { query: "FOO" });
  assert.deepEqual(r1.map((p) => p.id).sort(), ["a", "c"]);
  // Category filter is exact
  const r2 = filterPlugins(packs, { category: "dev" });
  assert.deepEqual(r2.map((p) => p.id).sort(), ["b", "c"]);
  // Combined
  const r3 = filterPlugins(packs, { query: "beta", category: "dev" });
  assert.deepEqual(r3.map((p) => p.id), ["b"]);
  // Empty category means "all"
  const r4 = filterPlugins(packs, { category: "" });
  assert.equal(r4.length, 3);
  // Does not mutate
  const copy = JSON.parse(JSON.stringify(packs));
  filterPlugins(packs, { query: "foo" });
  assert.deepEqual(packs, copy);
});

test("sortByName: case-insensitive, ties break by id, stable, returns new array", () => {
  const packs = [
    { id: "3", name: "banana" },
    { id: "1", name: "Apple" },
    { id: "2", name: "apple" },
    { id: "4", name: "Cherry" },
  ];
  const r = sortByName(packs);
  assert.deepEqual(r.map((p) => p.id), ["1", "2", "3", "4"]);
  // input not mutated
  assert.deepEqual(packs.map((p) => p.id), ["3", "1", "2", "4"]);
  // invalid input
  assert.deepEqual(sortByName(null), []);
  assert.deepEqual(sortByName(undefined), []);
});

test("summarizeManifest: tolerates missing fields and counts actions", () => {
  const empty = summarizeManifest(null);
  assert.equal(empty.name, "(untitled pack)");
  assert.equal(empty.version, "—");
  assert.equal(empty.author, "Unknown");
  assert.equal(empty.category, "uncategorized");
  assert.equal(empty.actionCount, 0);
  assert.deepEqual(empty.actions, []);

  const full = summarizeManifest({
    id: "x", name: "X", version: "1.2.3", author: "me",
    category: "tools", description: "d",
    actions: [{ name: "run", type: "shell" }, { name: "fetch", type: "http" }],
  });
  assert.equal(full.name, "X");
  assert.equal(full.version, "1.2.3");
  assert.equal(full.author, "me");
  assert.equal(full.actionCount, 2);
  assert.deepEqual(full.actions, [
    { name: "run", type: "shell" },
    { name: "fetch", type: "http" },
  ]);
});

test("installButtonLabel: covers all state transitions", () => {
  assert.equal(installButtonLabel(null), "Install");
  assert.equal(installButtonLabel({}), "Install");
  assert.equal(installButtonLabel({ installed: false }), "Install");
  assert.equal(installButtonLabel({ installed: true }), "Installed");
  assert.equal(installButtonLabel({ installed: true, enabled: false }), "Disabled");
  assert.equal(installButtonLabel({ installed: true, enabled: true }), "Installed");
  assert.equal(installButtonLabel({ installing: true }), "Installing…");
  // installing takes precedence over installed
  assert.equal(installButtonLabel({ installed: true, installing: true }), "Installing…");
});

test("pluginRowState + formatProgress", () => {
  assert.equal(pluginRowState(null), "available");
  assert.equal(pluginRowState({ installed: false }), "available");
  assert.equal(pluginRowState({ installed: true }), "enabled");
  assert.equal(pluginRowState({ installed: true, enabled: false }), "disabled");

  assert.equal(formatProgress(0), "0%");
  assert.equal(formatProgress(0.42), "42%");
  assert.equal(formatProgress(1), "100%");
  assert.equal(formatProgress(1.5), "100%");
  assert.equal(formatProgress(-0.2), "0%");
  assert.equal(formatProgress("abc"), "0%");
  assert.equal(formatProgress(undefined), "0%");
});
