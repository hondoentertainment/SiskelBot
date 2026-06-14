/**
 * Phase 41.2: Operational transform client.
 *
 * Maintains a local copy of a shared text document, queues local edits while
 * waiting for the server to acknowledge them, and transforms incoming remote
 * ops against the pending local queue so that all peers converge.
 *
 * Exposed as window.SiskelOT for use from the chat UI.
 *
 * Usage:
 *   const client = SiskelOT.createOTClient("doc-1", "hello", 0);
 *   client.insert(5, " world");
 *   const pending = client.getPendingOps();
 *   // ...send pending to server, on ack:
 *   client.onAck(1);
 *   // when a remote op arrives:
 *   client.applyRemoteOp({ version: 2, op: { type: "insert", ... } });
 */
(function () {
  "use strict";

  const OP_TYPES = {
    INSERT: "insert",
    DELETE: "delete",
    RETAIN: "retain",
  };

  function clamp(n, lo, hi) {
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function compareClientIds(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  function applyOp(text, op) {
    if (!op || typeof text !== "string") return text;
    if (op.type === OP_TYPES.RETAIN) return text;
    if (op.type === OP_TYPES.INSERT) {
      const pos = clamp(op.position, 0, text.length);
      return text.slice(0, pos) + (op.text || "") + text.slice(pos);
    }
    if (op.type === OP_TYPES.DELETE) {
      const pos = clamp(op.position, 0, text.length);
      const end = clamp(pos + (op.length || 0), 0, text.length);
      return text.slice(0, pos) + text.slice(end);
    }
    return text;
  }

  function transformOp(op1, op2) {
    if (!op1 || !op2) return op1;
    if (op1.type === OP_TYPES.RETAIN || op2.type === OP_TYPES.RETAIN) return { ...op1 };

    if (op1.type === OP_TYPES.INSERT && op2.type === OP_TYPES.INSERT) {
      if (op2.position < op1.position) {
        return { ...op1, position: op1.position + (op2.text || "").length };
      }
      if (op2.position === op1.position) {
        if (compareClientIds(op2.clientId, op1.clientId) < 0) {
          return { ...op1, position: op1.position + (op2.text || "").length };
        }
        return { ...op1 };
      }
      return { ...op1 };
    }

    if (op1.type === OP_TYPES.INSERT && op2.type === OP_TYPES.DELETE) {
      const delEnd = op2.position + (op2.length || 0);
      if (op1.position <= op2.position) return { ...op1 };
      if (op1.position >= delEnd) {
        return { ...op1, position: op1.position - (op2.length || 0) };
      }
      return { ...op1, position: op2.position };
    }

    if (op1.type === OP_TYPES.DELETE && op2.type === OP_TYPES.INSERT) {
      const delEnd = op1.position + (op1.length || 0);
      if (op2.position <= op1.position) {
        return { ...op1, position: op1.position + (op2.text || "").length };
      }
      if (op2.position >= delEnd) {
        return { ...op1 };
      }
      return { ...op1, length: (op1.length || 0) + (op2.text || "").length };
    }

    if (op1.type === OP_TYPES.DELETE && op2.type === OP_TYPES.DELETE) {
      const a1 = op1.position;
      const a2 = op1.position + (op1.length || 0);
      const b1 = op2.position;
      const b2 = op2.position + (op2.length || 0);

      if (b2 <= a1) return { ...op1, position: a1 - (op2.length || 0) };
      if (b1 >= a2) return { ...op1 };

      const newStart = Math.min(a1, b1);
      const overlap = Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
      const newLen = (op1.length || 0) - overlap;
      if (newLen <= 0) return { type: OP_TYPES.RETAIN, clientId: op1.clientId };
      return { ...op1, position: newStart, length: newLen };
    }

    return { ...op1 };
  }

  function transformCursor(cursor, op) {
    if (!op) return cursor;
    if (op.type === OP_TYPES.INSERT) {
      if (op.position <= cursor) {
        return cursor + (op.text || "").length;
      }
      return cursor;
    }
    if (op.type === OP_TYPES.DELETE) {
      const end = op.position + (op.length || 0);
      if (end <= cursor) return cursor - (op.length || 0);
      if (op.position >= cursor) return cursor;
      // Cursor is inside the deleted range; collapse to the deletion start.
      return op.position;
    }
    return cursor;
  }

  /**
   * Create a new OT client.
   * @param {string} docId
   * @param {string} initialText
   * @param {number} initialVersion
   * @param {object} [options]
   * @param {string} [options.clientId] - unique id used for tie-breaking
   */
  function createOTClient(docId, initialText, initialVersion, options) {
    const opts = options || {};
    const clientId = opts.clientId || ("c-" + Math.random().toString(36).slice(2, 10));
    let text = String(initialText || "");
    let version = Number.isFinite(initialVersion) ? initialVersion : 0;
    let cursor = 0;

    /** @type {Array<{ op: object, baseVersion: number }>} */
    const pending = [];

    function insert(position, str) {
      const op = {
        type: OP_TYPES.INSERT,
        position: clamp(position | 0, 0, text.length),
        text: String(str || ""),
        clientId,
      };
      text = applyOp(text, op);
      cursor = transformCursor(cursor, op);
      pending.push({ op, baseVersion: version });
      return op;
    }

    function del(position, length) {
      const op = {
        type: OP_TYPES.DELETE,
        position: clamp(position | 0, 0, text.length),
        length: Math.max(0, length | 0),
        clientId,
      };
      text = applyOp(text, op);
      cursor = transformCursor(cursor, op);
      pending.push({ op, baseVersion: version });
      return op;
    }

    /**
     * Apply a remote op (already accepted by the server) to local state.
     * The op is transformed against every still-pending local op so the local
     * text remains consistent.
     */
    function applyRemoteOp(remoteEntry) {
      if (!remoteEntry || !remoteEntry.op) return;
      let remote = { ...remoteEntry.op };
      // Transform against the pending queue, also rewriting pending ops in place
      // so they remain valid against the server's new text.
      for (let i = 0; i < pending.length; i++) {
        const localEntry = pending[i];
        const newLocal = transformOp(localEntry.op, remote);
        const newRemote = transformOp(remote, localEntry.op);
        pending[i] = { op: newLocal, baseVersion: localEntry.baseVersion };
        remote = newRemote;
      }
      text = applyOp(text, remote);
      cursor = transformCursor(cursor, remote);
      if (Number.isFinite(remoteEntry.version)) {
        version = remoteEntry.version;
      } else {
        version += 1;
      }
    }

    /**
     * Mark all pending ops up to and including the given server version as
     * acknowledged. Called when the server confirms our submitted ops.
     */
    function onAck(ackVersion) {
      version = Math.max(version, ackVersion | 0);
      // Drop the oldest pending op (FIFO ack model).
      if (pending.length > 0) pending.shift();
    }

    function getPendingOps() {
      return pending.map((entry) => ({ op: { ...entry.op }, baseVersion: entry.baseVersion }));
    }

    function getText() {
      return text;
    }

    function getVersion() {
      return version;
    }

    function getCursor() {
      return cursor;
    }

    function setCursor(pos) {
      cursor = clamp(pos | 0, 0, text.length);
      return cursor;
    }

    function getClientId() {
      return clientId;
    }

    return {
      docId,
      insert,
      delete: del,
      applyRemoteOp,
      onAck,
      getPendingOps,
      getText,
      getVersion,
      getCursor,
      setCursor,
      getClientId,
    };
  }

  const api = {
    OP_TYPES,
    createOTClient,
    applyOp,
    transformOp,
  };

  if (typeof window !== "undefined") {
    window.SiskelOT = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
