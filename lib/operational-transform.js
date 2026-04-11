/**
 * Phase 41.2: Operational transform for cursor-level text collaboration.
 *
 * Allows concurrent character-level edits to a shared text document without
 * conflicts. Each operation is one of:
 *   - insert(position, text)         insert `text` at `position`
 *   - delete(position, length)       remove `length` chars starting at `position`
 *   - retain                         no-op marker (used in compositions)
 *
 * Operations carry an optional `clientId` so the transform can break ties
 * deterministically when two clients edit the same position.
 *
 * The core property: for any concurrent ops a and b applied to the same base
 * document, applying a then transform(b, a) yields the same text as applying
 * b then transform(a, b). This convergence is what allows lock-free editing.
 */

export const OP_TYPES = {
  INSERT: "insert",
  DELETE: "delete",
  RETAIN: "retain",
};

/**
 * Create an insert operation.
 * @param {number} position - Character index to insert at.
 * @param {string} text - Text to insert.
 * @param {string} [clientId] - Originating client identifier (for tie-breaking).
 */
export function createInsertOp(position, text, clientId) {
  return {
    type: OP_TYPES.INSERT,
    position: Math.max(0, position | 0),
    text: String(text || ""),
    clientId: clientId || null,
  };
}

/**
 * Create a delete operation.
 * @param {number} position - Character index where deletion starts.
 * @param {number} length - Number of characters to remove.
 * @param {string} [clientId] - Originating client identifier.
 */
export function createDeleteOp(position, length, clientId) {
  return {
    type: OP_TYPES.DELETE,
    position: Math.max(0, position | 0),
    length: Math.max(0, length | 0),
    clientId: clientId || null,
  };
}

/**
 * Create a retain (no-op) operation. Useful as an explicit "do nothing" result
 * from transforms that fully cancel out.
 */
export function createRetainOp(clientId) {
  return { type: OP_TYPES.RETAIN, clientId: clientId || null };
}

/**
 * Apply an operation to a text string and return the resulting text.
 * @param {string} text
 * @param {object} op
 */
export function applyOp(text, op) {
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

/**
 * Transform `op1` against `op2` so that `op1` can be applied to a document
 * that has already had `op2` applied. Both `op1` and `op2` must originate from
 * the same base version. Returns the transformed `op1`.
 *
 * Tie-break rule when both ops are inserts at the same position: the op with
 * the lexicographically smaller `clientId` keeps its position; the other shifts
 * right by the inserter's length. If only one has a clientId, the one with a
 * clientId is treated as "earlier" and keeps its position.
 */
export function transformOp(op1, op2) {
  if (!op1 || !op2) return op1;
  if (op1.type === OP_TYPES.RETAIN || op2.type === OP_TYPES.RETAIN) return cloneOp(op1);

  // INSERT vs INSERT
  if (op1.type === OP_TYPES.INSERT && op2.type === OP_TYPES.INSERT) {
    if (op2.position < op1.position) {
      return { ...op1, position: op1.position + (op2.text || "").length };
    }
    if (op2.position === op1.position) {
      // Tie-break: smaller clientId stays put.
      if (compareClientIds(op2.clientId, op1.clientId) < 0) {
        return { ...op1, position: op1.position + (op2.text || "").length };
      }
      return cloneOp(op1);
    }
    return cloneOp(op1);
  }

  // INSERT vs DELETE
  if (op1.type === OP_TYPES.INSERT && op2.type === OP_TYPES.DELETE) {
    const delEnd = op2.position + (op2.length || 0);
    if (op1.position <= op2.position) return cloneOp(op1);
    if (op1.position >= delEnd) {
      return { ...op1, position: op1.position - (op2.length || 0) };
    }
    // Insert lands inside the deleted range; collapse to start of deletion.
    return { ...op1, position: op2.position };
  }

  // DELETE vs INSERT
  if (op1.type === OP_TYPES.DELETE && op2.type === OP_TYPES.INSERT) {
    const delEnd = op1.position + (op1.length || 0);
    if (op2.position <= op1.position) {
      return { ...op1, position: op1.position + (op2.text || "").length };
    }
    if (op2.position >= delEnd) {
      return cloneOp(op1);
    }
    // Insert lands inside our deletion: split deletion to span the inserted text.
    return { ...op1, length: (op1.length || 0) + (op2.text || "").length };
  }

  // DELETE vs DELETE
  if (op1.type === OP_TYPES.DELETE && op2.type === OP_TYPES.DELETE) {
    const a1 = op1.position;
    const a2 = op1.position + (op1.length || 0);
    const b1 = op2.position;
    const b2 = op2.position + (op2.length || 0);

    // Disjoint, op2 entirely before op1.
    if (b2 <= a1) {
      return { ...op1, position: a1 - (op2.length || 0) };
    }
    // Disjoint, op2 entirely after op1.
    if (b1 >= a2) {
      return cloneOp(op1);
    }
    // Overlap: compute the slice of op1's range that wasn't already deleted by op2.
    const newStart = Math.min(a1, b1);
    const overlap = Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
    const newLen = (op1.length || 0) - overlap;
    if (newLen <= 0) {
      return createRetainOp(op1.clientId);
    }
    return { ...op1, position: newStart, length: newLen };
  }

  return cloneOp(op1);
}

/**
 * Compose two sequential operations into one. Both ops must be applied in
 * order to the same evolving document. Returns either a single combined op
 * (when adjacent inserts/deletes can be merged) or an array of two ops.
 */
export function composeOps(op1, op2) {
  if (!op1) return op2 ? [cloneOp(op2)] : [];
  if (!op2) return [cloneOp(op1)];
  if (op1.type === OP_TYPES.RETAIN) return [cloneOp(op2)];
  if (op2.type === OP_TYPES.RETAIN) return [cloneOp(op1)];

  // Adjacent inserts from same client can merge into a single insert.
  if (op1.type === OP_TYPES.INSERT && op2.type === OP_TYPES.INSERT) {
    const op1End = op1.position + (op1.text || "").length;
    if (op2.position === op1End && op1.clientId === op2.clientId) {
      return [{
        type: OP_TYPES.INSERT,
        position: op1.position,
        text: (op1.text || "") + (op2.text || ""),
        clientId: op1.clientId,
      }];
    }
  }

  // Adjacent deletes from same client merge.
  if (op1.type === OP_TYPES.DELETE && op2.type === OP_TYPES.DELETE) {
    if (op2.position === op1.position && op1.clientId === op2.clientId) {
      return [{
        type: OP_TYPES.DELETE,
        position: op1.position,
        length: (op1.length || 0) + (op2.length || 0),
        clientId: op1.clientId,
      }];
    }
  }

  // Insert immediately followed by a delete that erases exactly what we just
  // inserted: cancel both.
  if (op1.type === OP_TYPES.INSERT && op2.type === OP_TYPES.DELETE) {
    if (
      op2.position === op1.position &&
      (op2.length || 0) === (op1.text || "").length
    ) {
      return [];
    }
  }

  return [cloneOp(op1), cloneOp(op2)];
}

/**
 * Build the inverse of an operation against the text it was applied to.
 * The result, when applied to `applyOp(text, op)`, restores `text`.
 *
 * @param {object} op - The op to invert.
 * @param {string} text - The document state BEFORE `op` was applied.
 */
export function invertOp(op, text) {
  if (!op) return null;
  if (op.type === OP_TYPES.RETAIN) return createRetainOp(op.clientId);
  if (op.type === OP_TYPES.INSERT) {
    return createDeleteOp(op.position, (op.text || "").length, op.clientId);
  }
  if (op.type === OP_TYPES.DELETE) {
    const pos = clamp(op.position, 0, text.length);
    const end = clamp(pos + (op.length || 0), 0, text.length);
    const removed = text.slice(pos, end);
    return createInsertOp(op.position, removed, op.clientId);
  }
  return null;
}

/**
 * Transform a batch of local ops against a single remote op, and the remote op
 * against each local op in turn. The local ops are assumed to be sequential
 * (each one applied after the previous), all originating from the same base
 * version as the remote op.
 *
 * @param {object[]} localOps
 * @param {object} remoteOp
 * @returns {{ localOps: object[], remoteOp: object }}
 */
export function transformOps(localOps, remoteOp) {
  const local = Array.isArray(localOps) ? localOps : [];
  let remote = cloneOp(remoteOp);
  const out = [];
  for (const op of local) {
    const transformedLocal = transformOp(op, remote);
    remote = transformOp(remote, op);
    out.push(transformedLocal);
  }
  return { localOps: out, remoteOp: remote };
}

// ---- helpers ----

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function cloneOp(op) {
  if (!op) return op;
  return { ...op };
}

function compareClientIds(a, b) {
  // null sorts AFTER any real id, so a real id is "earlier" and keeps its position.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
