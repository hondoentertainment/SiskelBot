/**
 * Phase 41.1: CRDT document sync.
 *
 * Conflict-free Replicated Data Types for collaborative editing.
 * Provides:
 *   - HybridLogicalClock — physical+logical hybrid clock for total ordering across replicas
 *   - LWWRegister       — Last-Writer-Wins register
 *   - ORSet             — Observed-Remove Set
 *   - RGA               — Replicated Growable Array (text/list ordering)
 *   - createCRDTDocument — wrapper that holds named CRDT fields with op log
 *
 * All types support deterministic merge so that any peer that observes the
 * same set of operations converges to the same state, regardless of order.
 */

import { randomUUID } from "crypto";

// ─── HybridLogicalClock ─────────────────────────────────────────────────────

/**
 * Hybrid Logical Clock (HLC).
 * Each tick returns { physical, logical, node } where:
 *   - physical: max(local wall clock, last known physical)
 *   - logical:  monotonically increasing counter when physical hasn't advanced
 *   - node:     stable id for the replica (used to break remaining ties)
 *
 * compare(a, b) returns -1, 0, or 1 with total ordering across replicas.
 */
export class HybridLogicalClock {
  constructor(nodeId) {
    this.nodeId = nodeId || randomUUID();
    this.physical = 0;
    this.logical = 0;
  }

  now() {
    return Date.now();
  }

  tick() {
    const wall = this.now();
    if (wall > this.physical) {
      this.physical = wall;
      this.logical = 0;
    } else {
      this.logical += 1;
    }
    return { physical: this.physical, logical: this.logical, node: this.nodeId };
  }

  /**
   * Update from a remote timestamp. Returns a fresh local timestamp that
   * dominates both the local state and the remote one.
   */
  update(other) {
    if (!other || typeof other.physical !== "number") return this.tick();
    const wall = this.now();
    const newPhysical = Math.max(this.physical, other.physical, wall);
    if (newPhysical === this.physical && newPhysical === other.physical) {
      this.logical = Math.max(this.logical, other.logical) + 1;
    } else if (newPhysical === this.physical) {
      this.logical += 1;
    } else if (newPhysical === other.physical) {
      this.logical = other.logical + 1;
    } else {
      this.logical = 0;
    }
    this.physical = newPhysical;
    return { physical: this.physical, logical: this.logical, node: this.nodeId };
  }

  /**
   * Static comparator. Total order by physical, then logical, then node id.
   * Returns negative if a<b, zero if equal, positive if a>b.
   */
  static compare(a, b) {
    if (!a && !b) return 0;
    if (!a) return -1;
    if (!b) return 1;
    if (a.physical !== b.physical) return a.physical - b.physical;
    if (a.logical !== b.logical) return a.logical - b.logical;
    if (a.node === b.node) return 0;
    return a.node < b.node ? -1 : 1;
  }

  compare(a, b) {
    return HybridLogicalClock.compare(a, b);
  }
}

// ─── LWWRegister ────────────────────────────────────────────────────────────

/**
 * Last-Writer-Wins Register. Holds a single value with a timestamp.
 * Concurrent writes are resolved by taking the one with the larger timestamp
 * (HLC total order, so ties are deterministic).
 */
export class LWWRegister {
  constructor(initialValue = null, clock = null) {
    this.value = initialValue;
    this.clock = clock || { physical: 0, logical: 0, node: "" };
  }

  set(value, clock) {
    if (HybridLogicalClock.compare(clock, this.clock) > 0) {
      this.value = value;
      this.clock = clock;
      return true;
    }
    return false;
  }

  get() {
    return this.value;
  }

  /**
   * Merge with another LWWRegister. Mutates this register so that it holds
   * the value with the higher timestamp. Returns true if state changed.
   */
  merge(other) {
    if (!other) return false;
    if (HybridLogicalClock.compare(other.clock, this.clock) > 0) {
      this.value = other.value;
      this.clock = other.clock;
      return true;
    }
    return false;
  }

  serialize() {
    return { type: "LWWRegister", value: this.value, clock: { ...this.clock } };
  }

  static deserialize(data) {
    if (!data || data.type !== "LWWRegister") {
      throw new Error("LWWRegister.deserialize: invalid payload");
    }
    return new LWWRegister(data.value, { ...data.clock });
  }
}

// ─── ORSet ──────────────────────────────────────────────────────────────────

/**
 * Observed-Remove Set. add() tags the new element with a unique id.
 * remove() can only remove ids that the local replica has previously
 * observed, so concurrent add/remove resolves in favor of the add.
 */
export class ORSet {
  constructor() {
    /** @type {Map<string, Set<string>>} item -> set of unique add ids */
    this.adds = new Map();
    /** @type {Set<string>} all unique ids that have been removed */
    this.removes = new Set();
  }

  /**
   * Add an item with a unique id. Returns the id used so callers can later
   * remove that exact tag.
   */
  add(item, uniqueId) {
    const id = uniqueId || randomUUID();
    let set = this.adds.get(item);
    if (!set) {
      set = new Set();
      this.adds.set(item, set);
    }
    set.add(id);
    return id;
  }

  /**
   * Remove an item by its tag(s). If uniqueIds is omitted, remove every
   * currently-observed tag for that item (a "purge").
   */
  remove(item, uniqueIds) {
    const set = this.adds.get(item);
    if (!set) return false;
    let removed = false;
    if (uniqueIds === undefined) {
      for (const id of set) {
        this.removes.add(id);
        removed = true;
      }
    } else {
      const ids = Array.isArray(uniqueIds) ? uniqueIds : [uniqueIds];
      for (const id of ids) {
        if (set.has(id)) {
          this.removes.add(id);
          removed = true;
        }
      }
    }
    return removed;
  }

  has(item) {
    const set = this.adds.get(item);
    if (!set) return false;
    for (const id of set) {
      if (!this.removes.has(id)) return true;
    }
    return false;
  }

  values() {
    const out = [];
    for (const [item, set] of this.adds.entries()) {
      for (const id of set) {
        if (!this.removes.has(id)) {
          out.push(item);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Merge with another ORSet. Adds union, removes union — commutative,
   * associative, idempotent.
   */
  merge(other) {
    if (!other) return;
    for (const [item, set] of other.adds.entries()) {
      let local = this.adds.get(item);
      if (!local) {
        local = new Set();
        this.adds.set(item, local);
      }
      for (const id of set) local.add(id);
    }
    for (const id of other.removes) this.removes.add(id);
  }

  serialize() {
    const adds = {};
    for (const [item, set] of this.adds.entries()) {
      adds[item] = Array.from(set);
    }
    return { type: "ORSet", adds, removes: Array.from(this.removes) };
  }

  static deserialize(data) {
    if (!data || data.type !== "ORSet") {
      throw new Error("ORSet.deserialize: invalid payload");
    }
    const set = new ORSet();
    for (const [item, ids] of Object.entries(data.adds || {})) {
      set.adds.set(item, new Set(ids));
    }
    for (const id of data.removes || []) set.removes.add(id);
    return set;
  }
}

// ─── RGA (Replicated Growable Array) ────────────────────────────────────────

/**
 * Replicated Growable Array — a list/text CRDT.
 *
 * Internally maintains a doubly-linked-ish list of nodes:
 *   { id, value, left, deleted }
 * where `left` is the id of the node this insertion was placed *after*.
 *
 * Each id MUST be a HLC timestamp (or any value HybridLogicalClock.compare
 * can totally order). Insertions with the same `left` are ordered by id
 * descending — the larger id appears first — which gives a stable, deterministic
 * resolution for concurrent inserts at the same anchor.
 */
export class RGA {
  constructor() {
    /** @type {Map<string, {id:any, value:any, left:string|null, deleted:boolean}>} */
    this.nodes = new Map();
    /** Insertion order tracker so toArray walks deterministically. */
    this.root = null; // first inserted node id (left=null with smallest order)
  }

  static idKey(id) {
    if (!id) return "";
    return `${id.physical}|${id.logical}|${id.node}`;
  }

  /**
   * Insert value at logical index (0..length). Caller supplies an HLC id.
   * Returns the id (key form) so callers can later delete.
   */
  insert(index, value, id) {
    const visible = this._visibleList();
    let leftKey = null;
    if (index > 0 && visible.length > 0) {
      const target = visible[Math.min(index - 1, visible.length - 1)];
      leftKey = target.key;
    }
    const key = RGA.idKey(id);
    this.nodes.set(key, { id, key, value, left: leftKey, deleted: false });
    return key;
  }

  /**
   * Append helper.
   */
  append(value, id) {
    return this.insert(this.toArray().length, value, id);
  }

  /**
   * Tombstone delete. Idempotent: deleting the same id twice is fine.
   */
  delete(idOrKey) {
    const key = typeof idOrKey === "string" ? idOrKey : RGA.idKey(idOrKey);
    const node = this.nodes.get(key);
    if (!node) return false;
    if (node.deleted) return false;
    node.deleted = true;
    return true;
  }

  /**
   * Walk the tree of nodes anchored to `left` and produce the visible list.
   * Concurrent inserts at the same `left` are ordered by id descending.
   */
  _visibleList() {
    const childrenByLeft = new Map();
    for (const node of this.nodes.values()) {
      const k = node.left || "__root__";
      if (!childrenByLeft.has(k)) childrenByLeft.set(k, []);
      childrenByLeft.get(k).push(node);
    }
    for (const arr of childrenByLeft.values()) {
      arr.sort((a, b) => HybridLogicalClock.compare(b.id, a.id));
    }
    const out = [];
    const visit = (parentKey) => {
      const kids = childrenByLeft.get(parentKey || "__root__") || [];
      for (const node of kids) {
        if (!node.deleted) out.push(node);
        visit(node.key);
        // Also include any deleted node's children (deleted parents are still
        // valid anchors so their descendants remain in the right place).
      }
    };
    visit(null);
    // Deleted parents are visited above; we still need to walk their children
    // even though we skipped pushing the deleted parent. The visit above
    // handles that because we recurse regardless of `deleted`.
    return out;
  }

  toArray() {
    return this._visibleList().map((n) => n.value);
  }

  /**
   * Merge another RGA: union of nodes, OR of deleted flags.
   */
  merge(other) {
    if (!other) return;
    for (const [key, node] of other.nodes.entries()) {
      const existing = this.nodes.get(key);
      if (!existing) {
        this.nodes.set(key, { ...node });
      } else if (node.deleted) {
        existing.deleted = true;
      }
    }
  }

  serialize() {
    const nodes = [];
    for (const node of this.nodes.values()) {
      nodes.push({
        id: node.id,
        value: node.value,
        left: node.left,
        deleted: node.deleted,
      });
    }
    return { type: "RGA", nodes };
  }

  static deserialize(data) {
    if (!data || data.type !== "RGA") {
      throw new Error("RGA.deserialize: invalid payload");
    }
    const rga = new RGA();
    for (const n of data.nodes || []) {
      const key = RGA.idKey(n.id);
      rga.nodes.set(key, { id: n.id, key, value: n.value, left: n.left, deleted: !!n.deleted });
    }
    return rga;
  }
}

// ─── CRDT Document ──────────────────────────────────────────────────────────

/**
 * Create a CRDT document. The document holds a map of named fields, each of
 * which is one of LWWRegister, ORSet, or RGA. Operations are recorded so
 * peers can sync via op log replay.
 *
 * Fields are dynamically created on first set: simple values become
 * LWWRegister, arrays become RGA, plain objects become ORSet (over JSON keys).
 *
 * To create a typed field explicitly, use createField(name, type).
 */
export function createCRDTDocument(docId, options = {}) {
  const id = docId || randomUUID();
  const clock = options.clock || new HybridLogicalClock(options.nodeId);
  /** @type {Map<string, LWWRegister|ORSet|RGA>} */
  const fields = new Map();
  /** @type {Array<object>} append-only operation log */
  const ops = [];

  function recordOp(op) {
    ops.push(op);
    return op;
  }

  function fieldType(field) {
    if (field instanceof LWWRegister) return "LWWRegister";
    if (field instanceof ORSet) return "ORSet";
    if (field instanceof RGA) return "RGA";
    return "unknown";
  }

  function createField(name, type) {
    let field;
    if (type === "LWWRegister") field = new LWWRegister();
    else if (type === "ORSet") field = new ORSet();
    else if (type === "RGA") field = new RGA();
    else throw new Error(`unknown CRDT field type: ${type}`);
    fields.set(name, field);
    return field;
  }

  function get(field) {
    const f = fields.get(field);
    if (!f) return undefined;
    if (f instanceof LWWRegister) return f.get();
    if (f instanceof ORSet) return f.values();
    if (f instanceof RGA) return f.toArray();
    return undefined;
  }

  function set(field, value) {
    let f = fields.get(field);
    if (!f) {
      // Default: scalar -> LWWRegister.
      f = createField(field, "LWWRegister");
    }
    if (!(f instanceof LWWRegister)) {
      throw new Error(`field ${field} is not an LWWRegister; use applyOp for ${fieldType(f)}`);
    }
    const ts = clock.tick();
    f.set(value, ts);
    return recordOp({ kind: "lww_set", field, value, clock: ts });
  }

  /**
   * Apply a single operation. Operations have a `kind` and a `field` and
   * additional kind-specific payload. Returns true if state changed.
   */
  function applyOp(op) {
    if (!op || typeof op.kind !== "string" || typeof op.field !== "string") return false;
    if (op.clock) clock.update(op.clock);

    let f = fields.get(op.field);
    let changed = false;

    switch (op.kind) {
      case "lww_set": {
        if (!f) f = createField(op.field, "LWWRegister");
        if (!(f instanceof LWWRegister)) return false;
        changed = f.set(op.value, op.clock);
        break;
      }
      case "orset_add": {
        if (!f) f = createField(op.field, "ORSet");
        if (!(f instanceof ORSet)) return false;
        f.add(op.value, op.uniqueId);
        changed = true;
        break;
      }
      case "orset_remove": {
        if (!f) return false;
        if (!(f instanceof ORSet)) return false;
        changed = f.remove(op.value, op.uniqueIds);
        break;
      }
      case "rga_insert": {
        if (!f) f = createField(op.field, "RGA");
        if (!(f instanceof RGA)) return false;
        const key = RGA.idKey(op.clock);
        if (!f.nodes.has(key)) {
          f.nodes.set(key, {
            id: op.clock,
            key,
            value: op.value,
            left: op.left || null,
            deleted: false,
          });
          changed = true;
        }
        break;
      }
      case "rga_delete": {
        if (!f) return false;
        if (!(f instanceof RGA)) return false;
        changed = f.delete(op.targetKey);
        break;
      }
      default:
        return false;
    }

    if (changed) ops.push(op);
    return changed;
  }

  function getOps(since) {
    if (!since) return ops.slice();
    return ops.filter((op) => HybridLogicalClock.compare(op.clock, since) > 0);
  }

  /**
   * Merge a remote document by serializing/deserializing its fields and
   * doing per-field merge. Operation logs are unioned (deduped by clock+kind).
   */
  function merge(remoteDoc) {
    if (!remoteDoc) return;
    const remoteFields = remoteDoc.fields instanceof Map ? remoteDoc.fields : new Map();
    for (const [name, remoteField] of remoteFields.entries()) {
      const local = fields.get(name);
      if (!local) {
        // Adopt the remote field directly via serialize roundtrip so we
        // don't share references.
        if (typeof remoteField.serialize === "function") {
          const data = remoteField.serialize();
          if (data.type === "LWWRegister") fields.set(name, LWWRegister.deserialize(data));
          else if (data.type === "ORSet") fields.set(name, ORSet.deserialize(data));
          else if (data.type === "RGA") fields.set(name, RGA.deserialize(data));
        }
      } else if (typeof local.merge === "function") {
        local.merge(remoteField);
      }
    }
    // Merge op logs, dedup by stringified clock+kind+field+value.
    if (Array.isArray(remoteDoc.getOps?.())) {
      const seen = new Set(ops.map(opKey));
      for (const op of remoteDoc.getOps()) {
        const k = opKey(op);
        if (!seen.has(k)) {
          ops.push(op);
          seen.add(k);
        }
      }
    }
  }

  function opKey(op) {
    return `${op.kind}|${op.field}|${op.clock?.physical}|${op.clock?.logical}|${op.clock?.node}`;
  }

  // ORSet helpers
  function addToSet(field, value, uniqueId) {
    let f = fields.get(field);
    if (!f) f = createField(field, "ORSet");
    if (!(f instanceof ORSet)) throw new Error(`field ${field} is not an ORSet`);
    const id = f.add(value, uniqueId);
    const ts = clock.tick();
    recordOp({ kind: "orset_add", field, value, uniqueId: id, clock: ts });
    return id;
  }

  function removeFromSet(field, value, uniqueIds) {
    const f = fields.get(field);
    if (!f || !(f instanceof ORSet)) return false;
    const ids = uniqueIds === undefined ? Array.from(f.adds.get(value) || []) : uniqueIds;
    const ok = f.remove(value, ids);
    if (ok) {
      const ts = clock.tick();
      recordOp({ kind: "orset_remove", field, value, uniqueIds: ids, clock: ts });
    }
    return ok;
  }

  // RGA helpers
  function rgaInsert(field, index, value) {
    let f = fields.get(field);
    if (!f) f = createField(field, "RGA");
    if (!(f instanceof RGA)) throw new Error(`field ${field} is not an RGA`);
    const ts = clock.tick();
    const visible = f._visibleList();
    let leftKey = null;
    if (index > 0 && visible.length > 0) {
      const target = visible[Math.min(index - 1, visible.length - 1)];
      leftKey = target.key;
    }
    f.nodes.set(RGA.idKey(ts), { id: ts, key: RGA.idKey(ts), value, left: leftKey, deleted: false });
    recordOp({ kind: "rga_insert", field, value, left: leftKey, clock: ts });
    return RGA.idKey(ts);
  }

  function rgaDelete(field, targetKey) {
    const f = fields.get(field);
    if (!f || !(f instanceof RGA)) return false;
    const ok = f.delete(targetKey);
    if (ok) {
      const ts = clock.tick();
      recordOp({ kind: "rga_delete", field, targetKey, clock: ts });
    }
    return ok;
  }

  function snapshot() {
    const out = { id, fields: {} };
    for (const [name, f] of fields.entries()) {
      out.fields[name] = f.serialize();
    }
    return out;
  }

  return {
    id,
    clock,
    fields,
    createField,
    get,
    set,
    applyOp,
    getOps,
    merge,
    addToSet,
    removeFromSet,
    rgaInsert,
    rgaDelete,
    snapshot,
  };
}
