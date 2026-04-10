import test from "node:test";
import assert from "node:assert/strict";
import { createSSEWriter, formatSSEEvent, setSSEHeaders } from "../lib/sse-writer.js";
import { createBufferPool } from "../lib/buffer-pool.js";

function makeRes({ writeReturns = true } = {}) {
  const headers = {};
  const chunks = [];
  let ended = false;
  let flushed = false;
  return {
    headers,
    chunks,
    get text() {
      return chunks.map((c) => (typeof c === "string" ? c : c.toString("utf8"))).join("");
    },
    get ended() { return ended; },
    get flushHeadersCalled() { return flushed; },
    headersSent: false,
    setHeader(k, v) { headers[k] = v; },
    flushHeaders() { flushed = true; },
    write(chunk) {
      chunks.push(chunk);
      return writeReturns;
    },
    end() { ended = true; },
  };
}

// Force synchronous flush by using flushIntervalMs = 0 and explicit flush() calls.
function newWriter(res, opts = {}) {
  return createSSEWriter(res, { flushIntervalMs: 0, maxBatchBytes: 8192, ...opts });
}

test("formatSSEEvent: data-only event ends with double newline", () => {
  assert.equal(formatSSEEvent(null, "hello"), "data: hello\n\n");
});

test("formatSSEEvent: named event prefixes with `event:`", () => {
  assert.equal(formatSSEEvent("ping", "1"), "event: ping\ndata: 1\n\n");
});

test("formatSSEEvent: multi-line data is split across multiple data lines", () => {
  const out = formatSSEEvent(null, "line1\nline2\nline3");
  assert.equal(out, "data: line1\ndata: line2\ndata: line3\n\n");
});

test("setSSEHeaders sets all required headers", () => {
  const res = makeRes();
  setSSEHeaders(res);
  assert.equal(res.headers["Content-Type"], "text/event-stream");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res.headers["Connection"], "keep-alive");
  assert.equal(res.headers["X-Accel-Buffering"], "no");
  assert.ok(res.flushHeadersCalled);
});

test("setSSEHeaders is a no-op once headers are sent", () => {
  const res = makeRes();
  res.headersSent = true;
  setSSEHeaders(res);
  assert.equal(Object.keys(res.headers).length, 0);
});

test("createSSEWriter writes data with proper SSE framing on flush", () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.writeData("hello");
  writer.flush();
  assert.equal(res.text, "data: hello\n\n");
});

test("createSSEWriter batches multiple events into a single write", () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.writeData("a");
  writer.writeData("b");
  writer.writeData("c");
  writer.flush();
  // All three events should have been combined into a single res.write call.
  assert.equal(res.chunks.length, 1);
  assert.equal(res.text, "data: a\n\ndata: b\n\ndata: c\n\n");
});

test("createSSEWriter end() flushes any pending batch", () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.writeData("hi");
  writer.end();
  assert.equal(res.text, "data: hi\n\n");
  assert.equal(res.ended, true);
});

test("createSSEWriter writeComment emits a comment line", () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.writeComment("keep-alive");
  writer.flush();
  assert.equal(res.text, ": keep-alive\n\n");
});

test("createSSEWriter named events", () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.write("update", "payload");
  writer.flush();
  assert.equal(res.text, "event: update\ndata: payload\n\n");
});

test("createSSEWriter back-pressure: write returns false when sink returns false", () => {
  const res = makeRes({ writeReturns: false });
  const writer = newWriter(res);
  writer.writeData("a");
  // The first event is queued; flush triggers the write that returns false.
  const ok = writer.flush();
  assert.equal(ok, false);
  const stats = writer.getStats();
  assert.equal(stats.lastWriteOk, false);
});

test("createSSEWriter flushes once batch exceeds maxBatchBytes", () => {
  const res = makeRes();
  // Each event is ~40 bytes framed; with maxBatchBytes=64 every second event
  // forces a flush before the new event is appended.
  const writer = newWriter(res, { maxBatchBytes: 64 });
  const big = "x".repeat(30); // framed = "data: " (6) + 30 + "\n\n" (2) = 38
  writer.writeData(big);
  writer.writeData(big);
  writer.writeData(big);
  writer.flush();
  // We expect at least two write() calls due to the size threshold.
  assert.ok(res.chunks.length >= 2, `expected >= 2 writes, got ${res.chunks.length}`);
  // All three events should still be present in the cumulative output.
  const occurrences = res.text.split(`data: ${big}\n\n`).length - 1;
  assert.equal(occurrences, 3);
});

test("createSSEWriter stats track bytes/events/flushes", () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.writeData("one");
  writer.writeData("two");
  writer.flush();
  const stats = writer.getStats();
  assert.equal(stats.eventsWritten, 2);
  assert.ok(stats.bytesWritten > 0);
  assert.equal(stats.flushCount, 1);
  assert.equal(stats.batchesWritten, 1);
  assert.equal(stats.pendingEvents, 0);
});

test("createSSEWriter uses provided buffer pool for reuse", () => {
  const res = makeRes();
  const pool = createBufferPool({ bufferSize: 16384, maxBuffers: 8 });
  const writer = createSSEWriter(res, { bufferPool: pool, flushIntervalMs: 0 });
  for (let i = 0; i < 5; i++) writer.writeData(`evt-${i}`);
  writer.flush();
  for (let i = 0; i < 5; i++) writer.writeData(`evt-${i}`);
  writer.flush();
  const stats = pool.stats();
  // After two flush rounds the second should reuse the released buffer.
  assert.ok(stats.totalReused >= 1, `expected reuse > 0, got ${stats.totalReused}`);
});

test("createSSEWriter end() is idempotent and prevents further writes", () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.writeData("first");
  writer.end();
  const ok = writer.writeData("second");
  assert.equal(ok, false);
  // The second write should not have produced output.
  assert.equal(res.text.includes("second"), false);
  // Calling end again should not throw or write anything else.
  writer.end();
  assert.equal(res.ended, true);
});

test("createSSEWriter scheduled flush via microtask when flushIntervalMs=0", async () => {
  const res = makeRes();
  const writer = newWriter(res);
  writer.writeData("scheduled");
  // Allow the queued microtask to run.
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(res.text.includes("data: scheduled\n\n"));
});
