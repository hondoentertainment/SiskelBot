/**
 * Unit tests for the realtime-event reducer exported from
 * client/src/views/runs.js.
 *
 * The reducer is intentionally pure so we can exercise it without
 * JSDOM, a WebSocket, or the surrounding mount() plumbing.
 */

import test from "node:test";
import assert from "node:assert/strict";

// Stub document so runs.js can import without a DOM (matches the
// companion client-views-runs.test.js file).
if (typeof globalThis.document === "undefined") {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ appendChild: () => {}, addEventListener: () => {}, setAttribute: () => {}, dataset: {} }),
    head: { appendChild: () => {} },
  };
}

const { mergeRunEvent } = await import("../client/src/views/runs.js");

// ── mergeRunEvent ───────────────────────────────────────────────────────────

test("mergeRunEvent applies status.change to the row", () => {
  const row = { id: "s1", status: "running", eventCount: 2 };
  const out = mergeRunEvent(row, {
    type: "status.change",
    payload: { status: "completed" },
    ts: "2026-04-15T10:00:00Z",
  });
  assert.equal(out.status, "completed");
  assert.equal(out.eventCount, 3);
  assert.equal(out.updatedAt, "2026-04-15T10:00:00Z");
  // input untouched
  assert.equal(row.status, "running");
  assert.equal(row.eventCount, 2);
  assert.equal(row.updatedAt, undefined);
});

test("mergeRunEvent treats a bare `done` event as terminal completion", () => {
  const row = { id: "s1", status: "running", eventCount: 5 };
  const out = mergeRunEvent(row, { type: "done", payload: {} });
  assert.equal(out.status, "completed");
  assert.equal(out.eventCount, 6);

  // Already-terminal rows are NOT demoted by a bare `done`.
  const done = { id: "s2", status: "failed", eventCount: 1 };
  const out2 = mergeRunEvent(done, { type: "done", payload: {} });
  assert.equal(out2.status, "failed");
});

test("mergeRunEvent bumps eventCount but leaves status alone for timeline-only events", () => {
  const row = { id: "s1", status: "running", eventCount: 0 };
  for (const type of ["tool.call", "tool.result", "plan.update", "artifact.new", "cost.update"]) {
    const out = mergeRunEvent(row, { type, payload: {} });
    assert.equal(out.status, "running", `${type} must not change status`);
    assert.equal(out.eventCount, 1, `${type} must bump eventCount`);
  }
});

test("mergeRunEvent ignores unknown event types and returns the original row", () => {
  const row = { id: "s1", status: "running", eventCount: 4 };
  const out = mergeRunEvent(row, { type: "random.noise", payload: {} });
  assert.strictEqual(out, row);
});

test("mergeRunEvent is defensive against malformed inputs", () => {
  // null row → return as-is (no throw)
  assert.equal(mergeRunEvent(null, { type: "status.change", payload: { status: "completed" } }), null);
  // missing event → row unchanged
  const row = { id: "s1", status: "running" };
  assert.strictEqual(mergeRunEvent(row, undefined), row);
  assert.strictEqual(mergeRunEvent(row, null), row);
  // missing eventCount on row → starts at 1
  const out = mergeRunEvent({ id: "s1", status: "running" }, { type: "tool.call", payload: {} });
  assert.equal(out.eventCount, 1);
});
