/**
 * Phase 30: In-memory async job queue with backpressure, concurrency control,
 * priority ordering, retry with exponential backoff, and dead-letter support.
 *
 * For production multi-instance deployments, back with Redis via REDIS_URL.
 */

import { randomUUID } from "crypto";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_SIZE = 10000;
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const DLQ_MAX = 1000;

/**
 * Create a new job queue.
 *
 * @param {object} [options]
 * @param {number} [options.concurrency]  Max concurrent jobs (default 5)
 * @param {number} [options.maxSize]      Max pending jobs before backpressure (default 10000)
 * @param {number} [options.timeout]      Per-job timeout in ms (default 30000)
 * @param {number} [options.retries]      Max retry attempts on failure (default 3)
 * @param {string} [options.name]         Queue name for logging
 * @returns {JobQueue}
 */
export function createJobQueue(options = {}) {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const maxRetries = options.retries ?? DEFAULT_RETRIES;
  const name = options.name || "default";

  /** @type {Array<QueueEntry>} min-heap by priority (higher = first) */
  const heap = [];
  /** @type {Map<string, QueueEntry>} */
  const jobMap = new Map();
  /** @type {Set<string>} */
  const activeJobs = new Set();
  /** @type {Array<{url?: string, job: object, error: string, failedAt: string}>} */
  const dlq = [];
  /** @type {Function|null} */
  let handler = null;
  let paused = false;
  let shuttingDown = false;
  let completed = 0;
  let failed = 0;
  let totalDurationMs = 0;

  /** Waiters blocked by backpressure */
  const backpressureWaiters = [];
  /** Waiters for drain() */
  const drainWaiters = [];

  // --- Heap operations (max-heap by priority) ---

  function heapParent(i) { return (i - 1) >> 1; }
  function heapLeft(i) { return 2 * i + 1; }
  function heapRight(i) { return 2 * i + 2; }

  function heapSwap(i, j) {
    const tmp = heap[i];
    heap[i] = heap[j];
    heap[j] = tmp;
  }

  function heapPush(entry) {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const p = heapParent(i);
      if (heap[p].priority >= heap[i].priority) break;
      heapSwap(i, p);
      i = p;
    }
  }

  function heapPop() {
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      while (true) {
        const l = heapLeft(i);
        const r = heapRight(i);
        let largest = i;
        if (l < heap.length && heap[l].priority > heap[largest].priority) largest = l;
        if (r < heap.length && heap[r].priority > heap[largest].priority) largest = r;
        if (largest === i) break;
        heapSwap(i, largest);
        i = largest;
      }
    }
    return top;
  }

  // --- Internal scheduling ---

  function tryProcessNext() {
    if (paused || shuttingDown) return;
    if (!handler) return;
    if (activeJobs.size >= concurrency) return;
    if (heap.length === 0) {
      checkDrain();
      return;
    }

    const entry = heapPop();
    if (!entry) return;

    activeJobs.add(entry.id);
    runJob(entry);

    // Recurse to fill concurrency slots
    if (activeJobs.size < concurrency && heap.length > 0) {
      tryProcessNext();
    }
  }

  async function runJob(entry) {
    const startTime = Date.now();
    let timer;

    try {
      const result = await Promise.race([
        handler(entry.job),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Job timed out after ${timeout}ms`)), timeout);
        }),
      ]);
      clearTimeout(timer);

      const duration = Date.now() - startTime;
      totalDurationMs += duration;
      completed++;

      activeJobs.delete(entry.id);
      jobMap.delete(entry.id);

      if (entry.resolve) entry.resolve(result);
      releaseBackpressure();
      tryProcessNext();
    } catch (err) {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      totalDurationMs += duration;

      activeJobs.delete(entry.id);

      entry.attempts++;
      if (entry.attempts < maxRetries) {
        // Retry with exponential backoff
        const delay = BACKOFF_BASE_MS * Math.pow(2, entry.attempts - 1);
        setTimeout(() => {
          if (shuttingDown) {
            jobMap.delete(entry.id);
            if (entry.reject) entry.reject(new Error("Queue shutting down"));
            return;
          }
          heapPush(entry);
          tryProcessNext();
        }, delay);
      } else {
        // Exhausted retries -- dead-letter
        failed++;
        jobMap.delete(entry.id);

        dlq.push({
          job: entry.job,
          error: err.message,
          failedAt: new Date().toISOString(),
          attempts: entry.attempts,
        });
        if (dlq.length > DLQ_MAX) {
          dlq.splice(0, dlq.length - DLQ_MAX);
        }

        if (entry.reject) entry.reject(err);
        releaseBackpressure();
        tryProcessNext();
      }
    }
  }

  function releaseBackpressure() {
    while (backpressureWaiters.length > 0 && pendingCount() < maxSize) {
      const waiter = backpressureWaiters.shift();
      waiter();
    }
  }

  function pendingCount() {
    return heap.length;
  }

  function checkDrain() {
    if (heap.length === 0 && activeJobs.size === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters.splice(0);
      for (const resolve of waiters) {
        resolve();
      }
    }
  }

  // --- Public API ---

  return {
    /**
     * Add a job to the queue.
     * Returns a promise that resolves with the job result or rejects on failure.
     * If queue is full (maxSize), the promise waits until space is available (backpressure).
     *
     * @param {object} job - { id?, type, payload, priority? }
     * @returns {Promise<*>} Job result from the handler
     */
    async add(job) {
      if (shuttingDown) {
        throw new Error(`Queue "${name}" is shutting down`);
      }

      // Backpressure: wait if at capacity
      if (pendingCount() >= maxSize) {
        await new Promise((resolve) => {
          backpressureWaiters.push(resolve);
        });
      }

      if (shuttingDown) {
        throw new Error(`Queue "${name}" is shutting down`);
      }

      const id = job.id || randomUUID();
      const priority = job.priority ?? 0;

      return new Promise((resolve, reject) => {
        const entry = {
          id,
          job: { id, type: job.type, payload: job.payload, priority },
          priority,
          attempts: 0,
          resolve,
          reject,
        };

        jobMap.set(id, entry);
        heapPush(entry);
        tryProcessNext();
      });
    },

    /**
     * Register a job processor function.
     * @param {(job: object) => Promise<*>} fn
     */
    process(fn) {
      if (typeof fn !== "function") {
        throw new TypeError("Handler must be a function");
      }
      handler = fn;
      // Kick off processing for any jobs already queued
      tryProcessNext();
    },

    /**
     * Get queue statistics.
     * @returns {{ pending: number, active: number, completed: number, failed: number, avgDuration: number, dlqSize: number }}
     */
    getStats() {
      const total = completed + failed;
      return {
        pending: heap.length,
        active: activeJobs.size,
        completed,
        failed,
        avgDuration: total > 0 ? Math.round(totalDurationMs / total) : 0,
        dlqSize: dlq.length,
      };
    },

    /**
     * Pause processing. Active jobs continue but no new jobs are started.
     */
    pause() {
      paused = true;
    },

    /**
     * Resume processing after pause.
     */
    resume() {
      paused = false;
      tryProcessNext();
    },

    /**
     * Wait for all pending and active jobs to complete.
     * @returns {Promise<void>}
     */
    drain() {
      if (heap.length === 0 && activeJobs.size === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    /**
     * Gracefully shut down the queue. Rejects pending jobs and waits for active ones.
     * @returns {Promise<void>}
     */
    async shutdown() {
      shuttingDown = true;
      paused = true;

      // Reject all backpressure waiters
      while (backpressureWaiters.length > 0) {
        backpressureWaiters.shift();
      }

      // Reject all pending (non-active) jobs
      while (heap.length > 0) {
        const entry = heapPop();
        if (entry) {
          jobMap.delete(entry.id);
          if (entry.reject) {
            entry.reject(new Error(`Queue "${name}" shut down`));
          }
        }
      }

      // Wait for active jobs to finish
      if (activeJobs.size > 0) {
        await new Promise((resolve) => {
          const check = setInterval(() => {
            if (activeJobs.size === 0) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
      }
    },

    /**
     * Get dead-letter queue entries.
     * @returns {Array<object>}
     */
    getDLQ() {
      return [...dlq];
    },

    /**
     * Clear the dead-letter queue.
     */
    clearDLQ() {
      dlq.length = 0;
    },

    /** Queue name */
    get name() { return name; },

    /** Whether the queue is paused */
    get paused() { return paused; },
  };
}

// Pre-configured queues for common workloads
export const toolQueue = createJobQueue({ concurrency: 5, name: "tools", timeout: 30000 });
export const webhookQueue = createJobQueue({ concurrency: 3, name: "webhooks", timeout: 10000 });
export const indexQueue = createJobQueue({ concurrency: 2, name: "indexing", timeout: 60000 });
