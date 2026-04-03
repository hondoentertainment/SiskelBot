/**
 * Phase 69: Tests for tracing-spans.js helper utilities.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { withSpan, addSpanEvent, recordSpanError } from "../lib/tracing-spans.js";

// The OTEL API returns no-op tracers/spans when no SDK is configured,
// so these tests exercise the helper logic without requiring a real backend.

test("withSpan returns the value from the wrapped function", async () => {
  const result = await withSpan("test.span", { "test.attr": "hello" }, async (span) => {
    assert.ok(span, "span should be provided to callback");
    return 42;
  });
  assert.equal(result, 42);
});

test("withSpan propagates errors and still completes", async () => {
  await assert.rejects(
    () =>
      withSpan("test.error_span", {}, async () => {
        throw new Error("boom");
      }),
    { message: "boom" }
  );
});

test("withSpan passes attributes and span is usable", async () => {
  await withSpan("test.attrs", { "key.one": 1, "key.two": "two" }, async (span) => {
    // span.setAttributes should not throw on a no-op span
    span.setAttributes({ "extra.attr": true });
    span.addEvent("test_event", { "ev.data": "ok" });
  });
});

test("withSpan with empty attributes works", async () => {
  const result = await withSpan("test.empty_attrs", {}, async () => "ok");
  assert.equal(result, "ok");
});

test("withSpan with null attributes works", async () => {
  const result = await withSpan("test.null_attrs", null, async () => "ok");
  assert.equal(result, "ok");
});

test("addSpanEvent does not throw outside an active span", () => {
  // No active span in a test environment (no SDK), should be a safe no-op.
  addSpanEvent("test.event", { foo: "bar" });
  addSpanEvent("test.event_no_attrs");
});

test("recordSpanError does not throw outside an active span", () => {
  recordSpanError(new Error("test error"));
  recordSpanError("string error");
});

test("recordSpanError works inside withSpan", async () => {
  await withSpan("test.record_error", {}, async () => {
    // Should not throw; records on the current span (no-op in test).
    recordSpanError(new Error("inner error"));
    recordSpanError("string inner error");
  });
});

test("withSpan nesting works (child sees parent context)", async () => {
  const order = [];
  await withSpan("parent", {}, async () => {
    order.push("parent_start");
    await withSpan("child", {}, async () => {
      order.push("child");
    });
    order.push("parent_end");
  });
  assert.deepEqual(order, ["parent_start", "child", "parent_end"]);
});

test("withSpan async timing is preserved", async () => {
  const t0 = Date.now();
  await withSpan("test.timing", {}, async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 15, `Expected >= 15ms, got ${elapsed}ms`);
});
