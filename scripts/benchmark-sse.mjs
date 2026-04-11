#!/usr/bin/env node
/**
 * Phase 35.3: SSE streaming benchmark.
 *
 * Measures throughput, per-event latency, allocations, and approximate GC
 * pressure for two SSE write paths:
 *
 *   1. legacy:    direct res.write(`data: ...\n\n`) per event (baseline)
 *   2. optimized: createSSEWriter() with buffer pool + batching
 *
 * Run:
 *   node scripts/benchmark-sse.mjs
 *   node scripts/benchmark-sse.mjs --events 200000 --payload 256
 */

import { performance } from "node:perf_hooks";
import { createSSEWriter } from "../lib/sse-writer.js";
import { createBufferPool } from "../lib/buffer-pool.js";

function parseArgs(argv) {
  const args = { events: 100000, payload: 128, runs: 3 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--events") args.events = Number(argv[++i]) || args.events;
    else if (a === "--payload") args.payload = Number(argv[++i]) || args.payload;
    else if (a === "--runs") args.runs = Number(argv[++i]) || args.runs;
  }
  return args;
}

/**
 * Minimal mock of an http.ServerResponse just sufficient for SSEWriter.
 * Counts bytes written and chunks (write calls), drops the data on the floor.
 */
function makeSink() {
  let bytes = 0;
  let writes = 0;
  return {
    bytes: () => bytes,
    writes: () => writes,
    headersSent: false,
    setHeader() {},
    flushHeaders() {},
    write(chunk) {
      writes += 1;
      if (typeof chunk === "string") {
        bytes += Buffer.byteLength(chunk, "utf8");
      } else if (chunk && typeof chunk.length === "number") {
        bytes += chunk.length;
      }
      return true;
    },
    end() {},
  };
}

function buildPayload(n) {
  // OpenAI-style delta, padded to roughly the requested size.
  const filler = "x".repeat(Math.max(0, n - 40));
  return JSON.stringify({ choices: [{ delta: { content: filler }, index: 0 }] });
}

function snapshotMem() {
  if (global.gc) global.gc();
  return process.memoryUsage();
}

function bytesPretty(n) {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

function runLegacy(events, payload) {
  const sink = makeSink();
  const start = performance.now();
  for (let i = 0; i < events; i++) {
    sink.write(`data: ${payload}\n\n`);
  }
  const elapsed = performance.now() - start;
  return { elapsed, bytes: sink.bytes(), writes: sink.writes() };
}

function runOptimized(events, payload) {
  const sink = makeSink();
  const pool = createBufferPool({ bufferSize: 16384, maxBuffers: 100 });
  const writer = createSSEWriter(sink, { bufferPool: pool, flushIntervalMs: 0, maxBatchBytes: 8192 });
  const start = performance.now();
  for (let i = 0; i < events; i++) {
    writer.writeData(payload);
  }
  writer.flush();
  const elapsed = performance.now() - start;
  return {
    elapsed,
    bytes: sink.bytes(),
    writes: sink.writes(),
    poolStats: pool.stats(),
    writerStats: writer.getStats(),
  };
}

function fmtRow(label, r, events) {
  const evtPerSec = ((events / r.elapsed) * 1000).toFixed(0);
  const usPerEvt = ((r.elapsed / events) * 1000).toFixed(2);
  return [
    label.padEnd(12),
    `${r.elapsed.toFixed(1)} ms`.padEnd(12),
    `${evtPerSec} ev/s`.padEnd(14),
    `${usPerEvt} us/ev`.padEnd(14),
    `${bytesPretty(r.bytes)}`.padEnd(12),
    `${r.writes} writes`.padEnd(16),
  ].join("");
}

async function main() {
  const args = parseArgs(process.argv);
  const payload = buildPayload(args.payload);

  console.log(`SiskelBot SSE benchmark`);
  console.log(`  events:   ${args.events}`);
  console.log(`  payload:  ~${args.payload} bytes`);
  console.log(`  runs:     ${args.runs}`);
  console.log("");

  // Header
  console.log(
    ["impl", "elapsed", "throughput", "per-event", "bytes", "writes"]
      .map((s, i) => s.padEnd(i === 5 ? 16 : i === 0 ? 12 : 14))
      .join(""),
  );
  console.log("-".repeat(80));

  for (let run = 0; run < args.runs; run++) {
    // Warm up the JIT once before measuring.
    runLegacy(1000, payload);
    runOptimized(1000, payload);

    const memBefore = snapshotMem();
    const legacy = runLegacy(args.events, payload);
    const memAfterLegacy = snapshotMem();
    const optimized = runOptimized(args.events, payload);
    const memAfterOptimized = snapshotMem();

    console.log(fmtRow("legacy", legacy, args.events));
    console.log(fmtRow("optimized", optimized, args.events));

    const speedup = (legacy.elapsed / optimized.elapsed).toFixed(2);
    const writeReduction = (
      ((legacy.writes - optimized.writes) / legacy.writes) *
      100
    ).toFixed(1);
    console.log(
      `  -> speedup: ${speedup}x   write-call reduction: ${writeReduction}%`,
    );
    if (optimized.poolStats) {
      console.log(
        `  -> pool: reuseRate=${(optimized.poolStats.reuseRate * 100).toFixed(1)}%` +
          ` allocated=${optimized.poolStats.totalAllocated}` +
          ` reused=${optimized.poolStats.totalReused}`,
      );
    }
    const heapDeltaLegacy = memAfterLegacy.heapUsed - memBefore.heapUsed;
    const heapDeltaOptimized = memAfterOptimized.heapUsed - memAfterLegacy.heapUsed;
    console.log(
      `  -> heapUsed delta: legacy=${bytesPretty(heapDeltaLegacy)} optimized=${bytesPretty(heapDeltaOptimized)}`,
    );
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
