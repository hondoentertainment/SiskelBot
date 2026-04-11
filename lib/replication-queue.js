/**
 * Phase 40.1: Replication queue for multi-region writes.
 * Persists pending replication operations to data/replication-queue.json
 * with a configurable size cap. Operations are drained asynchronously by
 * the multi-region manager and shipped to peer regions.
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { randomUUID } from "crypto";

const QUEUE_MAX_SIZE = parseInt(process.env.REPLICATION_QUEUE_MAX_SIZE, 10) || 10_000;

function queuePath() {
  return join(getDataDir(), "replication-queue.json");
}

function defaultQueue() {
  return { _version: 1, ops: [] };
}

/**
 * Enqueue a replication operation.
 * @param {object} op - { table, record, regionId?, type? }
 * @returns {Promise<{ id: string, enqueuedAt: string, dropped: boolean }>}
 */
export async function enqueueReplication(op) {
  if (!op || typeof op !== "object") {
    throw new Error("Replication op must be an object");
  }
  if (!op.table || typeof op.table !== "string") {
    throw new Error("Replication op requires a table");
  }

  const path = queuePath();
  return withPathLock(path, async () => {
    const data = normalize(await readJsonPath(path, defaultQueue()));
    const entry = {
      id: randomUUID(),
      table: op.table,
      record: op.record ?? null,
      type: op.type || "upsert",
      sourceRegion: op.sourceRegion || op.regionId || process.env.REGION_ID || "default",
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
    };

    let dropped = false;
    if (data.ops.length >= QUEUE_MAX_SIZE) {
      // Drop oldest entries to make room (FIFO bound).
      const overflow = data.ops.length - QUEUE_MAX_SIZE + 1;
      data.ops.splice(0, overflow);
      dropped = true;
    }
    data.ops.push(entry);
    await writeJsonPath(path, data);
    return { id: entry.id, enqueuedAt: entry.enqueuedAt, dropped };
  });
}

/**
 * Drain the replication queue, calling `handler(op)` on each entry.
 * Successful ops are removed; failed ops are retained with an incremented
 * attempt counter (capped at REPLICATION_QUEUE_MAX_ATTEMPTS).
 * @param {(op: object) => Promise<void>} [handler]
 * @returns {Promise<{ drained: number, failed: number, remaining: number }>}
 */
export async function drainReplicationQueue(handler) {
  const path = queuePath();
  return withPathLock(path, async () => {
    const data = normalize(await readJsonPath(path, defaultQueue()));
    const ops = data.ops.slice();
    const remaining = [];
    let drained = 0;
    let failed = 0;
    const maxAttempts = parseInt(process.env.REPLICATION_QUEUE_MAX_ATTEMPTS, 10) || 5;

    for (const op of ops) {
      if (!handler) {
        // No handler — drop everything (used for "clear" semantics).
        drained++;
        continue;
      }
      try {
        await handler(op);
        drained++;
      } catch (e) {
        failed++;
        op.attempts = (op.attempts || 0) + 1;
        op.lastError = e?.message || String(e);
        if (op.attempts < maxAttempts) {
          remaining.push(op);
        }
      }
    }
    data.ops = remaining;
    await writeJsonPath(path, data);
    return { drained, failed, remaining: remaining.length };
  });
}

/**
 * Get current queue size (number of pending ops).
 * @returns {Promise<number>}
 */
export async function getQueueSize() {
  const data = normalize(await readJsonPath(queuePath(), defaultQueue()));
  return data.ops.length;
}

/**
 * Peek at queue contents (read-only).
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function peekQueue(limit = 100) {
  const data = normalize(await readJsonPath(queuePath(), defaultQueue()));
  return data.ops.slice(0, limit);
}

/**
 * Clear the entire queue (admin / test).
 * @returns {Promise<number>} Number of ops cleared
 */
export async function clearQueue() {
  const path = queuePath();
  return withPathLock(path, async () => {
    const data = normalize(await readJsonPath(path, defaultQueue()));
    const count = data.ops.length;
    await writeJsonPath(path, defaultQueue());
    return count;
  });
}

function normalize(data) {
  if (!data || typeof data !== "object") return defaultQueue();
  if (!Array.isArray(data.ops)) return defaultQueue();
  return { _version: 1, ops: data.ops };
}

export const QUEUE_MAX = QUEUE_MAX_SIZE;
