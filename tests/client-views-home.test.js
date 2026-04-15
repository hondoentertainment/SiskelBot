/**
 * Unit tests for the pure helpers exported from
 * client/src/views/home.js.
 *
 * No JSDOM. The helpers never touch the DOM. We stub `document` for
 * belt + suspenders so the module body imports cleanly.
 */

import test from "node:test";
import assert from "node:assert/strict";

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
  formatTime,
  truncate,
  sortByCreatedAt,
  pickOpenHitl,
  formatLatencyMs,
  formatUsd,
} = await import("../client/src/views/home.js");

// ── formatTime ──────────────────────────────────────────────────────────────

test("formatTime returns — for null / undefined / empty / unparseable", () => {
  assert.equal(formatTime(null), "—");
  assert.equal(formatTime(undefined), "—");
  assert.equal(formatTime(""), "—");
  assert.equal(formatTime("not-a-date"), "—");
});

test("formatTime formats a valid ISO timestamp to a non-empty locale string", () => {
  const out = formatTime("2026-04-15T12:00:00Z");
  assert.ok(typeof out === "string" && out.length > 0);
  assert.notEqual(out, "—");
});

test("formatTime accepts numeric epoch ms", () => {
  const out = formatTime(Date.UTC(2026, 3, 15, 12, 0, 0));
  assert.ok(typeof out === "string" && out.length > 0);
  assert.notEqual(out, "—");
});

// ── truncate ────────────────────────────────────────────────────────────────

test("truncate leaves short strings alone", () => {
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("abc", 3), "abc");
});

test("truncate clips long strings and appends ellipsis", () => {
  assert.equal(truncate("abcdefghij", 5), "abcd\u2026");
  assert.equal(truncate("abcdefghij", 6), "abcde\u2026");
});

test("truncate handles nullish / non-string input", () => {
  assert.equal(truncate(null, 10), "");
  assert.equal(truncate(undefined, 10), "");
  assert.equal(truncate(42, 4), "42");
});

test("truncate with non-positive n returns empty string", () => {
  assert.equal(truncate("hello", 0), "");
  assert.equal(truncate("hello", -3), "");
  assert.equal(truncate("hello", NaN), "");
});

// ── sortByCreatedAt ─────────────────────────────────────────────────────────

test("sortByCreatedAt sorts newest first and is stable on ties", () => {
  const rows = [
    { id: "a", createdAt: "2026-04-01T00:00:00Z" },
    { id: "b", createdAt: "2026-04-14T00:00:00Z" },
    { id: "c", createdAt: "2026-04-14T00:00:00Z" }, // tie with b
    { id: "d", createdAt: "2026-04-10T00:00:00Z" },
  ];
  const out = sortByCreatedAt(rows);
  assert.deepEqual(out.map((r) => r.id), ["b", "c", "d", "a"]);
  // input not mutated
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c", "d"]);
});

test("sortByCreatedAt accepts numeric createdAt", () => {
  const rows = [
    { id: "a", createdAt: 100 },
    { id: "b", createdAt: 300 },
    { id: "c", createdAt: 200 },
  ];
  assert.deepEqual(sortByCreatedAt(rows).map((r) => r.id), ["b", "c", "a"]);
});

test("sortByCreatedAt returns [] for non-array input", () => {
  assert.deepEqual(sortByCreatedAt(null), []);
  assert.deepEqual(sortByCreatedAt(undefined), []);
  assert.deepEqual(sortByCreatedAt("nope"), []);
});

// ── pickOpenHitl ────────────────────────────────────────────────────────────

test("pickOpenHitl returns null when no rows are paused/awaiting approval", () => {
  assert.equal(pickOpenHitl([]), null);
  assert.equal(pickOpenHitl(null), null);
  assert.equal(
    pickOpenHitl([
      { id: "a", status: "running" },
      { id: "b", status: "completed" },
    ]),
    null,
  );
});

test("pickOpenHitl prefers awaitingApproval=true rows", () => {
  const rows = [
    { id: "a", status: "running", createdAt: "2026-04-10T00:00:00Z" },
    { id: "b", status: "running", awaitingApproval: true, createdAt: "2026-04-01T00:00:00Z" },
  ];
  const got = pickOpenHitl(rows);
  assert.equal(got?.id, "b");
});

test("pickOpenHitl falls back to status==='paused' (newest first)", () => {
  const rows = [
    { id: "old", status: "paused", createdAt: "2026-04-01T00:00:00Z" },
    { id: "new", status: "paused", createdAt: "2026-04-14T00:00:00Z" },
    { id: "mid", status: "running", createdAt: "2026-04-10T00:00:00Z" },
  ];
  const got = pickOpenHitl(rows);
  assert.equal(got?.id, "new");
});

test("pickOpenHitl is case-insensitive on status", () => {
  const rows = [{ id: "x", status: "PAUSED", createdAt: 1 }];
  assert.equal(pickOpenHitl(rows)?.id, "x");
});

// ── formatLatencyMs ─────────────────────────────────────────────────────────

test("formatLatencyMs formats sub-second as ms", () => {
  assert.equal(formatLatencyMs(123), "123 ms");
  assert.equal(formatLatencyMs(1), "1 ms");
  assert.equal(formatLatencyMs(999), "999 ms");
});

test("formatLatencyMs formats >= 1s as seconds with 1 decimal", () => {
  assert.equal(formatLatencyMs(1000), "1.0 s");
  assert.equal(formatLatencyMs(1250), "1.3 s");
});

test("formatLatencyMs returns — for zero / negative / non-numeric", () => {
  assert.equal(formatLatencyMs(0), "—");
  assert.equal(formatLatencyMs(-5), "—");
  assert.equal(formatLatencyMs("fast"), "—");
  assert.equal(formatLatencyMs(NaN), "—");
  assert.equal(formatLatencyMs(null), "—");
});

// ── formatUsd ───────────────────────────────────────────────────────────────

test("formatUsd formats small values with 4 decimals", () => {
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(0.5), "$0.5000");
});

test("formatUsd formats >= $1 with 2 decimals", () => {
  assert.equal(formatUsd(1.2345), "$1.23");
  assert.equal(formatUsd(42), "$42.00");
});

test("formatUsd handles zero, negatives, and non-numbers", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(-0.5), "-$0.5000");
  assert.equal(formatUsd(NaN), "—");
  assert.equal(formatUsd("0.5"), "—");
  assert.equal(formatUsd(null), "—");
});
