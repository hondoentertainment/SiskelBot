/**
 * Phase 35.3: High-performance SSE writer with buffer pooling and batching.
 *
 * Reduces syscall overhead and GC pressure by:
 *   - Batching multiple SSE events into a single res.write() call
 *   - Reusing pooled buffers from lib/buffer-pool.js when possible
 *   - Honoring back-pressure (writes return false when the socket buffer is full)
 *
 * Wire format follows the standard SSE spec:
 *   event: <name>\n
 *   data: <payload>\n\n
 *
 * Multi-line payloads are split across multiple `data:` lines per the spec.
 */

import { sseBufferPool } from "./buffer-pool.js";
import { recordSSEWrite, recordSSEBatch } from "./metrics.js";

const DEFAULT_FLUSH_INTERVAL_MS = 10;

/**
 * Set the standard SSE response headers.
 * @param {import('http').ServerResponse} res
 */
export function setSSEHeaders(res) {
  if (!res || res.headersSent) return;
  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Disable proxy buffering (nginx, etc.) so chunks reach the client promptly.
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
  } catch (_) {}
}

/**
 * Format a single SSE event into its on-the-wire string form.
 * Exposed for testing.
 * @param {string|null|undefined} event
 * @param {string} data
 * @returns {string}
 */
export function formatSSEEvent(event, data) {
  let out = "";
  if (event) out += `event: ${event}\n`;
  if (data == null) {
    out += "data: \n\n";
    return out;
  }
  const text = String(data);
  if (text.indexOf("\n") === -1) {
    out += `data: ${text}\n\n`;
  } else {
    const lines = text.split("\n");
    for (const line of lines) out += `data: ${line}\n`;
    out += "\n";
  }
  return out;
}

/**
 * Create a high-performance SSE writer wrapping a Node.js HTTP response.
 *
 * @param {import('http').ServerResponse} res
 * @param {{ bufferPool?: ReturnType<typeof import('./buffer-pool.js').createBufferPool>, flushIntervalMs?: number, maxBatchBytes?: number }} [options]
 */
export function createSSEWriter(res, options) {
  const opts = options || {};
  const pool = opts.bufferPool || sseBufferPool;
  const flushIntervalMs = Math.max(0, Number(opts.flushIntervalMs) || DEFAULT_FLUSH_INTERVAL_MS);
  const maxBatchBytes = Math.max(64, Number(opts.maxBatchBytes) || 8192);

  /** @type {string[]} */
  let batch = [];
  let batchByteLength = 0;
  let flushScheduled = false;
  /** @type {NodeJS.Timeout | null} */
  let flushTimer = null;
  let lastWriteOk = true;
  let ended = false;

  // Stats
  let bytesWritten = 0;
  let eventsWritten = 0;
  let flushCount = 0;
  let batchesWritten = 0;

  function scheduleFlush() {
    if (flushScheduled || ended) return;
    flushScheduled = true;
    if (flushIntervalMs <= 0) {
      // Flush on next tick.
      queueMicrotask(flush);
    } else {
      flushTimer = setTimeout(flush, flushIntervalMs);
      // Don't keep the event loop alive solely for SSE flushes.
      if (flushTimer && typeof flushTimer.unref === "function") flushTimer.unref();
    }
  }

  function clearFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushScheduled = false;
  }

  function flush() {
    clearFlushTimer();
    if (batch.length === 0) return true;
    const payload = batch.join("");
    batch = [];
    batchByteLength = 0;
    return writePayload(payload);
  }

  function writePayload(payload) {
    if (!payload) return true;
    const byteLen = Buffer.byteLength(payload, "utf8");
    let buf = null;
    let useBuf = false;
    // Try to use a pooled buffer when the payload fits.
    if (byteLen <= pool.stats().bufferSize) {
      try {
        buf = pool.acquire(byteLen);
        if (buf && buf.length >= byteLen) {
          buf.write(payload, 0, byteLen, "utf8");
          useBuf = true;
        }
      } catch (_) {
        useBuf = false;
      }
    }

    const start = Date.now();
    let ok = true;
    try {
      if (useBuf && buf) {
        // Slice (no copy) to the actual payload length so res.write doesn't
        // emit the trailing garbage from the pooled buffer.
        ok = res.write(buf.subarray(0, byteLen));
      } else {
        ok = res.write(payload);
      }
    } catch (_) {
      ok = false;
    } finally {
      if (useBuf && buf) {
        // Return the buffer to the pool for reuse.
        try { pool.release(buf); } catch (_) {}
      }
    }

    bytesWritten += byteLen;
    flushCount += 1;
    batchesWritten += 1;
    lastWriteOk = ok;
    try {
      recordSSEWrite(byteLen, Date.now() - start);
      recordSSEBatch();
    } catch (_) {}
    return ok;
  }

  function write(event, data) {
    if (ended) return false;
    const payload = formatSSEEvent(event, data);
    eventsWritten += 1;
    const len = Buffer.byteLength(payload, "utf8");
    // If adding this event would exceed maxBatchBytes, flush first.
    if (batchByteLength + len > maxBatchBytes && batch.length > 0) {
      flush();
    }
    batch.push(payload);
    batchByteLength += len;
    if (batchByteLength >= maxBatchBytes) {
      // Payload is large enough to flush immediately.
      return flush();
    }
    scheduleFlush();
    return lastWriteOk;
  }

  function writeData(data) {
    return write(null, data);
  }

  function writeComment(comment) {
    if (ended) return false;
    const text = String(comment == null ? "" : comment);
    const payload = `: ${text}\n\n`;
    eventsWritten += 1;
    const len = Buffer.byteLength(payload, "utf8");
    if (batchByteLength + len > maxBatchBytes && batch.length > 0) {
      flush();
    }
    batch.push(payload);
    batchByteLength += len;
    scheduleFlush();
    return lastWriteOk;
  }

  function end() {
    if (ended) return;
    flush();
    ended = true;
    clearFlushTimer();
    try { res.end(); } catch (_) {}
  }

  function getStats() {
    return {
      bytesWritten,
      eventsWritten,
      flushCount,
      batchesWritten,
      pendingBytes: batchByteLength,
      pendingEvents: batch.length,
      lastWriteOk,
      ended,
    };
  }

  return { write, writeData, writeComment, flush, end, getStats };
}
