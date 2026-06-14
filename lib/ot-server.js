/**
 * Phase 41.2: Operational transform server.
 *
 * Hosts authoritative shared text documents. Clients submit ops tagged with
 * the document version they were created against. The server transforms each
 * incoming op against any ops it has applied since that version, applies the
 * result, bumps the version, and returns the new state.
 *
 * Documents are stored in-memory only. For durable collaboration, persist
 * snapshots and op history through the storage layer.
 */
import {
  applyOp,
  transformOp,
  OP_TYPES,
} from "./operational-transform.js";

const MAX_OP_HISTORY = 1000;

/**
 * Create a new OT server instance.
 */
export function createOTServer() {
  /** @type {Map<string, { id: string, text: string, version: number, ops: Array<{ version: number, op: object }> }>} */
  const docs = new Map();

  function createDocument(docId, initialText = "") {
    if (!docId) throw new Error("docId required");
    if (docs.has(docId)) return docs.get(docId);
    const doc = {
      id: docId,
      text: String(initialText || ""),
      version: 0,
      ops: [],
    };
    docs.set(docId, doc);
    return doc;
  }

  function getDocument(docId) {
    return docs.get(docId) || null;
  }

  function deleteDocument(docId) {
    return docs.delete(docId);
  }

  function listDocuments() {
    return Array.from(docs.keys());
  }

  /**
   * Apply a client op against the document. The op was created when the
   * document was at `baseVersion`; the server transforms it against any ops
   * applied since then before persisting.
   *
   * @param {string} docId
   * @param {object} op - the operation (insert/delete) to apply
   * @param {number} baseVersion - version the client thought it was editing
   * @returns {{ version: number, op: object, text: string }} the post-transform op and new doc state
   */
  function applyClientOp(docId, op, baseVersion) {
    const doc = docs.get(docId);
    if (!doc) throw new Error(`unknown document: ${docId}`);
    if (!op || typeof op !== "object") throw new Error("op required");
    if (op.type !== OP_TYPES.INSERT && op.type !== OP_TYPES.DELETE) {
      throw new Error(`unsupported op type: ${op.type}`);
    }
    const base = Number.isFinite(baseVersion) ? baseVersion : doc.version;
    if (base > doc.version) {
      throw new Error(`baseVersion ${base} ahead of server ${doc.version}`);
    }

    let transformed = { ...op };
    // Transform against every op the client hasn't seen yet.
    for (const entry of doc.ops) {
      if (entry.version > base) {
        transformed = transformOp(transformed, entry.op);
      }
    }

    doc.text = applyOp(doc.text, transformed);
    doc.version += 1;
    doc.ops.push({ version: doc.version, op: transformed });

    // Trim history so memory doesn't grow without bound.
    if (doc.ops.length > MAX_OP_HISTORY) {
      doc.ops.splice(0, doc.ops.length - MAX_OP_HISTORY);
    }

    return { version: doc.version, op: transformed, text: doc.text };
  }

  /**
   * Return all ops with version strictly greater than `version`. Used by clients
   * to catch up after reconnecting or missing a message.
   */
  function getOpsSince(docId, version) {
    const doc = docs.get(docId);
    if (!doc) return [];
    const since = Number.isFinite(version) ? version : 0;
    return doc.ops.filter((entry) => entry.version > since).map((entry) => ({
      version: entry.version,
      op: { ...entry.op },
    }));
  }

  /**
   * Reset the entire server (used in tests).
   */
  function clear() {
    docs.clear();
  }

  return {
    createDocument,
    getDocument,
    deleteDocument,
    listDocuments,
    applyClientOp,
    getOpsSince,
    clear,
  };
}

/** Default singleton used by the realtime layer. */
let defaultServer = null;

export function getDefaultOTServer() {
  if (!defaultServer) defaultServer = createOTServer();
  return defaultServer;
}
