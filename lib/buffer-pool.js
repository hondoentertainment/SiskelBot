/**
 * Phase 35.3: Buffer pool for reusing allocated buffers to reduce GC pressure.
 *
 * A simple object pool that reuses Node.js Buffer instances. Useful for
 * high-throughput streaming paths (e.g. SSE) where allocating and discarding
 * buffers per chunk creates measurable GC overhead.
 *
 * Usage:
 *   const pool = createBufferPool({ bufferSize: 16384, maxBuffers: 100 });
 *   const buf = pool.acquire(1024);     // returns a Buffer of >= 1024 bytes
 *   ... write into buf ...
 *   pool.release(buf);                  // return buffer to pool for reuse
 */

const DEFAULT_BUFFER_SIZE = 16384;
const DEFAULT_MAX_BUFFERS = 100;

/**
 * Create a buffer pool.
 * @param {{ bufferSize?: number, maxBuffers?: number }} [options]
 * @returns {{
 *   acquire: (size?: number) => Buffer,
 *   release: (buffer: Buffer) => boolean,
 *   stats: () => { poolSize: number, totalAllocated: number, totalReused: number, reuseRate: number, bufferSize: number, maxBuffers: number },
 *   drain: () => void,
 * }}
 */
export function createBufferPool(options) {
  const opts = options || {};
  const bufferSize = Math.max(1, Number(opts.bufferSize) || DEFAULT_BUFFER_SIZE);
  const maxBuffers = Math.max(0, Number(opts.maxBuffers) || DEFAULT_MAX_BUFFERS);

  /** @type {Buffer[]} */
  const pool = [];
  let totalAllocated = 0;
  let totalReused = 0;

  function acquire(size) {
    const need = Math.max(1, Number(size) || bufferSize);
    // Try to find a buffer in the pool that satisfies the size.
    // Pop from the end (LIFO) for cache locality.
    if (need <= bufferSize && pool.length > 0) {
      const buf = pool.pop();
      totalReused++;
      return buf;
    }
    totalAllocated++;
    // Allocate at least bufferSize so the buffer is reusable for the pool.
    const allocSize = Math.max(bufferSize, need);
    return Buffer.allocUnsafe(allocSize);
  }

  function release(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer)) return false;
    // Only accept buffers of the standard pool size; oversized custom
    // allocations are dropped to the GC.
    if (buffer.length !== bufferSize) return false;
    if (pool.length >= maxBuffers) return false;
    pool.push(buffer);
    return true;
  }

  function stats() {
    const total = totalAllocated + totalReused;
    const reuseRate = total > 0 ? totalReused / total : 0;
    return {
      poolSize: pool.length,
      totalAllocated,
      totalReused,
      reuseRate,
      bufferSize,
      maxBuffers,
    };
  }

  function drain() {
    pool.length = 0;
  }

  return { acquire, release, stats, drain };
}

/**
 * Shared SSE buffer pool used by lib/sse-writer.js. 16 KiB buffers are large
 * enough for typical SSE event batches without being wasteful.
 */
export const sseBufferPool = createBufferPool({ bufferSize: 16384, maxBuffers: 100 });
