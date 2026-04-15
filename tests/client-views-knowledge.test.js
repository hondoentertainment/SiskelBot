/**
 * Unit tests for the pure helpers exported from
 * client/src/views/knowledge.js. No JSDOM required.
 */

import test from "node:test";
import assert from "node:assert/strict";

if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ appendChild: () => {}, addEventListener: () => {}, setAttribute: () => {}, dataset: {} }),
    head: { appendChild: () => {} },
  };
}

const { formatDocSize, rankSearchResults, layoutEntitiesCircular } = await import(
  "../client/src/views/knowledge.js"
);

test("formatDocSize handles 0, null, undefined, strings, KB and MB", () => {
  assert.equal(formatDocSize(0), "0 B");
  assert.equal(formatDocSize(null), "—");
  assert.equal(formatDocSize(undefined), "—");
  assert.equal(formatDocSize("abc"), "—");
  assert.equal(formatDocSize(1024), "1.0 KB");
  assert.equal(formatDocSize(1048576), "1.0 MB");
});

test("rankSearchResults handles empty input and does not mutate", () => {
  assert.deepEqual(rankSearchResults([], "q"), []);
  assert.deepEqual(rankSearchResults(null, "q"), []);
  const input = [{ score: 0.5, title: "a" }, { score: 0.9, title: "b" }];
  const copy = JSON.parse(JSON.stringify(input));
  rankSearchResults(input, "q");
  assert.deepEqual(input, copy);
});

test("rankSearchResults stable sort: score desc, updatedAt desc, title asc", () => {
  const r = rankSearchResults([
    { score: 0.5, title: "c", updatedAt: "2024-01-01" },
    { score: 0.9, title: "a", updatedAt: "2024-01-01" },
    { score: 0.5, title: "b", updatedAt: "2024-05-01" },
    { score: 0.5, title: "a", updatedAt: "2024-01-01" },
  ], "q");
  assert.deepEqual(r.map((x) => x.title), ["a", "b", "a", "c"]);
});

test("layoutEntitiesCircular: 0, 1, 4 entities, determinism and finite coords", () => {
  assert.deepEqual(layoutEntitiesCircular([]), []);
  const one = layoutEntitiesCircular([{ id: "x", name: "X", type: "t" }], 100, { x: 50, y: 50 });
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0].x - 50) < 1e-9);
  assert.ok(Math.abs(one[0].y - (-50)) < 1e-9);
  assert.equal(one[0].id, "x");
  const a = layoutEntitiesCircular([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]);
  const b = layoutEntitiesCircular([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]);
  assert.deepEqual(a, b);
  for (const p of a) {
    assert.ok(Number.isFinite(p.x));
    assert.ok(Number.isFinite(p.y));
  }
});
