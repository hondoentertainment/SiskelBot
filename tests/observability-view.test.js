/**
 * Tests for pure formatting helpers exported from
 * client/src/views/observability.js.
 *
 * These helpers are exported separately from the DOM mount() function so
 * they can be tested without JSDOM.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { formatDuration, formatBreakerRow, sortBySlowest } = await import(
  "../client/src/views/observability.js"
);

test("formatDuration formats sub-second values in ms", () => {
  assert.equal(formatDuration(0), "<1ms");
  assert.equal(formatDuration(1), "1ms");
  assert.equal(formatDuration(42), "42ms");
  assert.equal(formatDuration(999), "999ms");
});

test("formatDuration formats seconds with one decimal", () => {
  assert.equal(formatDuration(1000), "1.0s");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(59_999), "60.0s");
});

test("formatDuration formats minutes + seconds", () => {
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(3_600_000), "60m");
});

test("formatDuration handles invalid input", () => {
  assert.equal(formatDuration(NaN), "—");
  assert.equal(formatDuration(-1), "—");
  assert.equal(formatDuration("not a number"), "—");
  assert.equal(formatDuration(undefined), "—");
});

test("formatBreakerRow normalises the state string and exposes isOpen", () => {
  const row = formatBreakerRow({ name: "openai", state: "OPEN", failures: 7, lastFailureAt: "2024-01-01T00:00:00Z" });
  assert.equal(row.name, "openai");
  assert.equal(row.state, "open");
  assert.equal(row.failures, 7);
  assert.equal(row.lastFailureAt, "2024-01-01T00:00:00Z");
  assert.equal(row.isOpen, true);
});

test("formatBreakerRow handles missing fields", () => {
  const row = formatBreakerRow({});
  assert.equal(row.name, "unknown");
  assert.equal(row.state, "unknown");
  assert.equal(row.failures, 0);
  assert.equal(row.lastFailureAt, "—");
  assert.equal(row.isOpen, false);
});

test("formatBreakerRow recognises closed state", () => {
  const row = formatBreakerRow({ name: "ollama", state: "closed" });
  assert.equal(row.isOpen, false);
  assert.equal(row.state, "closed");
});

test("sortBySlowest orders rows by p95 descending", () => {
  const rows = [
    { route: "a", p95Ms: 100, hits: 10 },
    { route: "b", p95Ms: 900, hits: 3 },
    { route: "c", p95Ms: 450, hits: 20 },
  ];
  const sorted = sortBySlowest(rows);
  assert.deepEqual(sorted.map((r) => r.route), ["b", "c", "a"]);
  // input is not mutated
  assert.deepEqual(rows.map((r) => r.route), ["a", "b", "c"]);
});

test("sortBySlowest breaks ties on hits", () => {
  const rows = [
    { route: "a", p95Ms: 500, hits: 1 },
    { route: "b", p95Ms: 500, hits: 9 },
    { route: "c", p95Ms: 500, hits: 4 },
  ];
  const sorted = sortBySlowest(rows);
  assert.deepEqual(sorted.map((r) => r.route), ["b", "c", "a"]);
});

test("sortBySlowest handles non-array input", () => {
  assert.deepEqual(sortBySlowest(null), []);
  assert.deepEqual(sortBySlowest(undefined), []);
  assert.deepEqual(sortBySlowest("nope"), []);
  assert.deepEqual(sortBySlowest([]), []);
});

test("sortBySlowest coerces missing p95Ms to 0", () => {
  const rows = [{ route: "a" }, { route: "b", p95Ms: 100 }];
  const sorted = sortBySlowest(rows);
  assert.equal(sorted[0].route, "b");
  assert.equal(sorted[1].route, "a");
});
