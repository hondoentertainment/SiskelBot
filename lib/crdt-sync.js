/**
 * Phase 41.1: CRDT sync manager.
 *
 * Coordinates CRDT operation broadcast and remote application for one or
 * more documents. Decoupled from any transport — callers wire `broadcast`
 * (e.g. WebSocket emit) and pass remote ops in via handleRemoteOp.
 *
 * Pending ops are tracked so callers can retry on transport failures.
 */

import { HybridLogicalClock } from "./crdt.js";

/**
 * @param {object} options
 * @param {(op:object)=>(void|Promise<void>)} [options.broadcast]
 * @param {(op:object)=>(void|Promise<void>)} [options.onRemoteUpdate]
 * @param {string} [options.nodeId]
 */
export function createSyncManager(options = {}) {
  const broadcastFn = typeof options.broadcast === "function" ? options.broadcast : () => {};
  const onRemoteUpdate = typeof options.onRemoteUpdate === "function" ? options.onRemoteUpdate : () => {};
  /** @type {Map<string, ReturnType<import("./crdt.js").createCRDTDocument>>} */
  const docs = new Map();
  /** @type {Map<string, object[]>} docId -> queued ops awaiting flush */
  const pending = new Map();

  function attachDocument(doc) {
    if (!doc || !doc.id) throw new Error("attachDocument: doc.id required");
    docs.set(doc.id, doc);
    if (!pending.has(doc.id)) pending.set(doc.id, []);
    return doc;
  }

  function detachDocument(docId) {
    docs.delete(docId);
    pending.delete(docId);
  }

  function getDocument(docId) {
    return docs.get(docId);
  }

  /**
   * Broadcast a single op for a doc to remote peers. Records the op in the
   * pending list and clears once the broadcast resolves.
   */
  async function broadcastOp(docId, op) {
    if (!op || !docId) return;
    const queue = pending.get(docId) || [];
    queue.push(op);
    pending.set(docId, queue);
    try {
      await broadcastFn({ docId, op });
      // remove from pending on success
      const idx = queue.indexOf(op);
      if (idx >= 0) queue.splice(idx, 1);
    } catch (err) {
      // leave in pending; caller can retry via flushPending
      throw err;
    }
  }

  /**
   * Apply a remote op to the matching local document. Updates HLC and
   * notifies the onRemoteUpdate callback.
   */
  function handleRemoteOp(payload) {
    if (!payload || !payload.docId || !payload.op) return false;
    const doc = docs.get(payload.docId);
    if (!doc) return false;
    const changed = doc.applyOp(payload.op);
    if (changed) {
      try {
        onRemoteUpdate({ docId: payload.docId, op: payload.op, doc });
      } catch (_) {}
    }
    return changed;
  }

  function getPendingOps(docId) {
    if (docId) return (pending.get(docId) || []).slice();
    const out = {};
    for (const [k, v] of pending.entries()) out[k] = v.slice();
    return out;
  }

  async function flushPending(docId) {
    const queue = pending.get(docId);
    if (!queue || queue.length === 0) return 0;
    const drained = queue.splice(0);
    let sent = 0;
    for (const op of drained) {
      try {
        await broadcastFn({ docId, op });
        sent += 1;
      } catch (err) {
        queue.unshift(op);
        throw err;
      }
    }
    return sent;
  }

  /**
   * Full state exchange between two CRDT documents (e.g., on reconnect).
   * Mutates the local doc and returns the union of local+remote state.
   */
  function fullSync(docId, peerDoc) {
    const local = docs.get(docId);
    if (!local || !peerDoc) return null;
    local.merge(peerDoc);
    return local.snapshot();
  }

  function compareTimestamps(a, b) {
    return HybridLogicalClock.compare(a, b);
  }

  return {
    attachDocument,
    detachDocument,
    getDocument,
    broadcastOp,
    handleRemoteOp,
    getPendingOps,
    flushPending,
    fullSync,
    compareTimestamps,
  };
}
