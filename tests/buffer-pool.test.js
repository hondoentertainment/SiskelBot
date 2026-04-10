import test from "node:test";
import assert from "node:assert/strict";
import { createBufferPool, sseBufferPool } from "../lib/buffer-pool.js";

test("createBufferPool: acquire returns a Buffer of at least requested size", () => {
  const pool = createBufferPool({ bufferSize: 1024, maxBuffers: 4 });
  const buf = pool.acquire(512);
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length >= 512);
});

test("createBufferPool: release/acquire round-trips for reuse", () => {
  const pool = createBufferPool({ bufferSize: 1024, maxBuffers: 4 });
  const a = pool.acquire(100);
  pool.release(a);
  const b = pool.acquire(100);
  assert.equal(a, b, "expected the released buffer to be returned on next acquire");
  const stats = pool.stats();
  assert.equal(stats.totalAllocated, 1);
  assert.equal(stats.totalReused, 1);
});

test("createBufferPool: max pool size is enforced", () => {
  const pool = createBufferPool({ bufferSize: 256, maxBuffers: 2 });
  const buf1 = pool.acquire();
  const buf2 = pool.acquire();
  const buf3 = pool.acquire();
  // Release three buffers; only two should be retained.
  assert.equal(pool.release(buf1), true);
  assert.equal(pool.release(buf2), true);
  assert.equal(pool.release(buf3), false, "third release should be rejected (pool full)");
  const stats = pool.stats();
  assert.equal(stats.poolSize, 2);
});

test("createBufferPool: rejects buffers of wrong size", () => {
  const pool = createBufferPool({ bufferSize: 256, maxBuffers: 4 });
  const odd = Buffer.allocUnsafe(123);
  assert.equal(pool.release(odd), false);
  const stats = pool.stats();
  assert.equal(stats.poolSize, 0);
});

test("createBufferPool: stats track reuseRate", () => {
  const pool = createBufferPool({ bufferSize: 64, maxBuffers: 8 });
  // 3 fresh allocations
  const bufs = [pool.acquire(), pool.acquire(), pool.acquire()];
  for (const b of bufs) pool.release(b);
  // 3 reuses
  for (let i = 0; i < 3; i++) {
    const b = pool.acquire();
    pool.release(b);
  }
  const stats = pool.stats();
  assert.equal(stats.totalAllocated, 3);
  assert.equal(stats.totalReused, 3);
  assert.equal(stats.reuseRate, 0.5);
});

test("createBufferPool: drain clears the pool", () => {
  const pool = createBufferPool({ bufferSize: 64, maxBuffers: 4 });
  // Acquire two buffers up front, then release both, so the pool actually
  // ends with two distinct entries (release-then-acquire would just reuse).
  const a = pool.acquire();
  const b = pool.acquire();
  pool.release(a);
  pool.release(b);
  assert.equal(pool.stats().poolSize, 2);
  pool.drain();
  assert.equal(pool.stats().poolSize, 0);
});

test("createBufferPool: oversized acquire bypasses pool", () => {
  const pool = createBufferPool({ bufferSize: 128, maxBuffers: 4 });
  // Pre-fill the pool.
  pool.release(pool.acquire());
  const big = pool.acquire(4096);
  assert.ok(big.length >= 4096);
  // Releasing the oversized buffer should not pollute the pool.
  assert.equal(pool.release(big), false);
});

test("createBufferPool: ignores non-buffer release", () => {
  const pool = createBufferPool({ bufferSize: 128, maxBuffers: 4 });
  assert.equal(pool.release(null), false);
  assert.equal(pool.release("not a buffer"), false);
  assert.equal(pool.release({}), false);
});

test("sseBufferPool is a usable singleton", () => {
  assert.equal(typeof sseBufferPool.acquire, "function");
  assert.equal(typeof sseBufferPool.release, "function");
  const buf = sseBufferPool.acquire(64);
  assert.ok(Buffer.isBuffer(buf));
  sseBufferPool.release(buf);
});
