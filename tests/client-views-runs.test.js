/**
 * Unit tests for the pure helpers exported from
 * client/src/views/runs.js.
 *
 * The helpers are exported separately from the DOM mount() function so
 * they can be exercised without JSDOM.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Stub document so runs.js can import without a DOM. The helpers don't
// touch the DOM, but the module body checks for document existence inside
// ensureStylesheet() only — which is guarded and never runs at import.
// Nevertheless, inject a minimal stub for belt + suspenders.
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ appendChild: () => {}, addEventListener: () => {}, setAttribute: () => {}, dataset: {} }),
    head: { appendChild: () => {} },
  };
}

const { formatStatus, sortRows, filterRows } = await import(
  "../client/src/views/runs.js"
);

// ── formatStatus ────────────────────────────────────────────────────────────

test("formatStatus maps known statuses to badge label + color class", () => {
  assert.deepEqual(formatStatus("running"), {
    label: "Running",
    cls: "runs-badge runs-badge-running",
  });
  assert.deepEqual(formatStatus("paused"), {
    label: "Paused",
    cls: "runs-badge runs-badge-paused",
  });
  assert.deepEqual(formatStatus("completed"), {
    label: "Complete",
    cls: "runs-badge runs-badge-ok",
  });
  assert.deepEqual(formatStatus("failed"), {
    label: "Failed",
    cls: "runs-badge runs-badge-bad",
  });
});

test("formatStatus normalises casing and whitespace", () => {
  assert.equal(formatStatus("  RUNNING ").label, "Running");
  assert.equal(formatStatus("Completed").label, "Complete");
  assert.equal(formatStatus("Complete").label, "Complete");
});

test("formatStatus handles unknown / missing statuses", () => {
  const a = formatStatus(undefined);
  assert.equal(a.label, "unknown");
  assert.equal(a.cls, "runs-badge runs-badge-muted");

  const b = formatStatus("");
  assert.equal(b.label, "unknown");

  const c = formatStatus("weirdstate");
  assert.equal(c.label, "weirdstate");
  assert.equal(c.cls, "runs-badge runs-badge-muted");
});

// ── sortRows ────────────────────────────────────────────────────────────────

test("sortRows defaults to createdAt descending (newest first)", () => {
  const rows = [
    { id: "a", createdAt: "2026-04-01T00:00:00Z" },
    { id: "b", createdAt: "2026-04-14T00:00:00Z" },
    { id: "c", createdAt: "2026-04-10T00:00:00Z" },
  ];
  const out = sortRows(rows);
  assert.deepEqual(out.map((r) => r.id), ["b", "c", "a"]);
  // input is not mutated
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "c"]);
});

test("sortRows is stable on equal keys (preserves input order)", () => {
  const rows = [
    { id: "a", createdAt: "2026-04-10T00:00:00Z" },
    { id: "b", createdAt: "2026-04-10T00:00:00Z" },
    { id: "c", createdAt: "2026-04-10T00:00:00Z" },
  ];
  const out = sortRows(rows);
  assert.deepEqual(out.map((r) => r.id), ["a", "b", "c"]);
});

test("sortRows accepts numeric createdAt (epoch ms)", () => {
  const rows = [
    { id: "a", createdAt: 100 },
    { id: "b", createdAt: 300 },
    { id: "c", createdAt: 200 },
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.id), ["b", "c", "a"]);
});

test("sortRows(by=title) sorts alphabetically ascending", () => {
  const rows = [
    { id: "a", title: "Zeta" },
    { id: "b", title: "Alpha" },
    { id: "c", title: "Mu" },
  ];
  assert.deepEqual(
    sortRows(rows, "title").map((r) => r.id),
    ["b", "c", "a"],
  );
});

test("sortRows(by=status) sorts alphabetically", () => {
  const rows = [
    { id: "a", status: "running" },
    { id: "b", status: "failed" },
    { id: "c", status: "completed" },
  ];
  assert.deepEqual(
    sortRows(rows, "status").map((r) => r.id),
    ["c", "b", "a"],
  );
});

test("sortRows treats missing createdAt as 0 (oldest)", () => {
  const rows = [
    { id: "a" },
    { id: "b", createdAt: "2026-04-10T00:00:00Z" },
    { id: "c" },
  ];
  const out = sortRows(rows);
  // b has the only real timestamp → first. a and c tie at 0; stable order.
  assert.deepEqual(out.map((r) => r.id), ["b", "a", "c"]);
});

test("sortRows handles non-array input", () => {
  assert.deepEqual(sortRows(null), []);
  assert.deepEqual(sortRows(undefined), []);
  assert.deepEqual(sortRows("nope"), []);
  assert.deepEqual(sortRows([]), []);
});

// ── filterRows ──────────────────────────────────────────────────────────────

const SAMPLE = [
  { id: "s1", title: "Deploy pipeline", status: "running" },
  { id: "s2", title: "Research cadence", status: "completed" },
  { id: "s3", title: "Incident triage", status: "failed" },
  { id: "s4", title: "Deploy hotfix",   status: "paused" },
  { id: "s5", title: "Doc sweep",       status: "complete" }, // alt spelling
];

test("filterRows returns all rows when no filters supplied", () => {
  assert.deepEqual(filterRows(SAMPLE, {}).map((r) => r.id), ["s1", "s2", "s3", "s4", "s5"]);
});

test("filterRows filters by exact status", () => {
  assert.deepEqual(filterRows(SAMPLE, { statusFilter: "running" }).map((r) => r.id), ["s1"]);
  assert.deepEqual(filterRows(SAMPLE, { statusFilter: "failed" }).map((r) => r.id), ["s3"]);
  assert.deepEqual(filterRows(SAMPLE, { statusFilter: "paused" }).map((r) => r.id), ["s4"]);
});

test("filterRows treats 'completed' and 'complete' as equivalent", () => {
  const out = filterRows(SAMPLE, { statusFilter: "completed" });
  assert.deepEqual(out.map((r) => r.id).sort(), ["s2", "s5"]);

  const out2 = filterRows(SAMPLE, { statusFilter: "complete" });
  assert.deepEqual(out2.map((r) => r.id).sort(), ["s2", "s5"]);
});

test("filterRows with statusFilter='all' keeps every row", () => {
  assert.equal(filterRows(SAMPLE, { statusFilter: "all" }).length, SAMPLE.length);
});

test("filterRows searches title (case-insensitive substring)", () => {
  assert.deepEqual(
    filterRows(SAMPLE, { query: "deploy" }).map((r) => r.id),
    ["s1", "s4"],
  );
  assert.deepEqual(
    filterRows(SAMPLE, { query: "CADENCE" }).map((r) => r.id),
    ["s2"],
  );
});

test("filterRows matches against id as a fallback", () => {
  assert.deepEqual(
    filterRows(SAMPLE, { query: "s3" }).map((r) => r.id),
    ["s3"],
  );
});

test("filterRows composes status + query filters", () => {
  assert.deepEqual(
    filterRows(SAMPLE, { statusFilter: "paused", query: "deploy" }).map((r) => r.id),
    ["s4"],
  );
  assert.deepEqual(
    filterRows(SAMPLE, { statusFilter: "running", query: "deploy" }).map((r) => r.id),
    ["s1"],
  );
  assert.deepEqual(
    filterRows(SAMPLE, { statusFilter: "failed", query: "deploy" }).map((r) => r.id),
    [],
  );
});

test("filterRows handles non-array input", () => {
  assert.deepEqual(filterRows(null, {}), []);
  assert.deepEqual(filterRows(undefined, {}), []);
  assert.deepEqual(filterRows("nope", {}), []);
});

test("filterRows trims the query and treats empty as no-op", () => {
  assert.equal(filterRows(SAMPLE, { query: "   " }).length, SAMPLE.length);
});
