/**
 * Phase 48.3: On-chain audit log anchoring.
 *
 * Computes deterministic Merkle trees over batches of audit events and
 * produces "anchor receipts" suitable for optional submission to an external
 * blockchain (or any other tamper-evident log). Because SiskelBot cannot
 * depend on a live chain, submission is pluggable: the default submitter is
 * a local/mock that returns a deterministic fake tx hash, and an optional
 * HTTP submitter broadcasts the batch payload via fetch for operators that
 * run their own relay.
 *
 * Verification is purely local: given an audit event id and an anchor id,
 * verifyAuditEvent returns a Merkle proof that can be recomputed by anyone
 * who has the event payload and the anchored root, without needing any
 * external service.
 *
 * Storage layout (json-path-store):
 *   data/audit-anchors/_index.json
 *     { _version: 1, byId: { [batchId]: { chain, workspaceId, submittedAt } } }
 *   data/audit-anchors/{batchId}.json
 *     { _version: 1, batch, merkleTree, receipt? }
 *
 * @module audit-anchor
 */
import crypto from "node:crypto";
import { join } from "node:path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";
import { queryAudit } from "./audit-query.js";

const STORE_VERSION = 1;
const ANCHOR_SUBDIR = "audit-anchors";
const INDEX_FILE = "_index.json";

// ─── hashing helpers ─────────────────────────────────────────────────────────

/**
 * Hex SHA-256 of a string or Buffer.
 * @param {string|Buffer} data
 * @returns {string}
 */
export function sha256(data) {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Canonicalize a JSON value deterministically (sorted keys, no whitespace) so
 * that semantically equal objects produce identical Merkle leaves regardless
 * of property ordering or storage round-trip.
 * @param {any} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k]));
  return "{" + parts.join(",") + "}";
}

/**
 * Hash a single audit event into a Merkle leaf.
 * @param {object} event
 * @returns {string}
 */
export function hashEvent(event) {
  return sha256(canonicalJson(event));
}

/**
 * Concatenate two hex-hashes and hash the result.
 * @param {string} left
 * @param {string} right
 * @returns {string}
 */
function hashPair(left, right) {
  return sha256(Buffer.concat([Buffer.from(left, "hex"), Buffer.from(right, "hex")]));
}

// ─── Merkle tree ─────────────────────────────────────────────────────────────

/**
 * Build a Merkle tree from an array of leaves. Leaves may be raw strings or
 * pre-hashed hex. If a level has an odd count, the last element is duplicated
 * (traditional Bitcoin-style). Returns the tree including every intermediate
 * level so that proofs can be generated without rebuilding.
 *
 * @param {Array<string>} leaves - already hashed hex leaves
 * @returns {{ root: string|null, levels: Array<Array<string>>, leaves: Array<string> }}
 */
export function buildMerkleTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    return { root: null, levels: [], leaves: [] };
  }
  // Validate and normalize hex input.
  const normalized = leaves.map((l) => {
    if (typeof l !== "string") throw new Error("buildMerkleTree: leaves must be hex strings");
    return l.toLowerCase();
  });

  const levels = [normalized];
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = i + 1 < current.length ? current[i + 1] : current[i]; // duplicate last when odd
      next.push(hashPair(left, right));
    }
    levels.push(next);
  }
  return {
    root: levels[levels.length - 1][0],
    levels,
    leaves: normalized,
  };
}

/**
 * Produce a Merkle inclusion proof for the leaf at `leafIndex`.
 * @param {{ root: string|null, levels: Array<Array<string>>, leaves: Array<string> }} tree
 * @param {number} leafIndex
 * @returns {{ leaf: string, root: string, leafIndex: number, siblings: Array<{hash:string,position:"left"|"right"}> }}
 */
export function generateMerkleProof(tree, leafIndex) {
  if (!tree || !Array.isArray(tree.levels) || tree.levels.length === 0) {
    throw new Error("generateMerkleProof: empty tree");
  }
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(`generateMerkleProof: leafIndex ${leafIndex} out of range`);
  }
  const siblings = [];
  let index = leafIndex;
  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    // Duplicate-last rule: if sibling out of range, the sibling is the node itself.
    const siblingHash = siblingIndex < nodes.length ? nodes[siblingIndex] : nodes[index];
    siblings.push({
      hash: siblingHash,
      position: isRight ? "left" : "right",
    });
    index = Math.floor(index / 2);
  }
  return {
    leaf: tree.leaves[leafIndex],
    root: tree.root,
    leafIndex,
    siblings,
  };
}

/**
 * Verify a Merkle proof by recomputing the root from the leaf and sibling
 * chain. Returns true iff the recomputed root matches the proof root.
 * @param {{ leaf: string, root: string, siblings: Array<{hash:string,position:"left"|"right"}> }} proof
 * @returns {boolean}
 */
export function verifyMerkleProof(proof) {
  if (!proof || typeof proof.leaf !== "string" || typeof proof.root !== "string") return false;
  if (!Array.isArray(proof.siblings)) return false;
  let current = proof.leaf.toLowerCase();
  for (const step of proof.siblings) {
    if (!step || typeof step.hash !== "string") return false;
    const sibling = step.hash.toLowerCase();
    if (step.position === "left") {
      current = hashPair(sibling, current);
    } else if (step.position === "right") {
      current = hashPair(current, sibling);
    } else {
      return false;
    }
  }
  return current === proof.root.toLowerCase();
}

// ─── batch lifecycle ─────────────────────────────────────────────────────────

function anchorDir() {
  return join(getDataDir(), ANCHOR_SUBDIR);
}

function anchorIndexPath() {
  return join(anchorDir(), INDEX_FILE);
}

function anchorBatchPath(batchId) {
  return join(anchorDir(), `${batchId}.json`);
}

function newBatchId() {
  return `anchor_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Extract or synthesize a stable identifier for an audit event so that later
 * callers can reference it in verifyAuditEvent.
 * @param {object} event
 * @param {number} index
 * @returns {string}
 */
function eventStableId(event, index) {
  if (!event || typeof event !== "object") return `idx:${index}`;
  if (typeof event.id === "string" && event.id) return event.id;
  if (typeof event.eventId === "string" && event.eventId) return event.eventId;
  if (typeof event.timestamp === "string" && typeof event.action === "string") {
    return `${event.timestamp}|${event.action}|${index}`;
  }
  return `idx:${index}`;
}

/**
 * Create an anchor batch from a list of audit events. Builds the Merkle tree,
 * persists the batch on disk, and updates the index. Does NOT submit to any
 * chain — call submitAnchor separately.
 *
 * @param {Array<object>} events
 * @param {object} [options]
 * @param {string} [options.chain]
 * @param {string} [options.workspaceId]
 * @param {string} [options.batchId]
 * @returns {Promise<{ batchId:string, root:string|null, eventCount:number, createdAt:string, merkleTree:object, eventIds:Array<string> }>}
 */
export async function createAnchorBatch(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const batchId = options.batchId || newBatchId();
  const chain = options.chain || "mock";
  const workspaceId = options.workspaceId || null;
  const createdAt = new Date().toISOString();

  const eventIds = list.map((e, i) => eventStableId(e, i));
  const leaves = list.map((e) => hashEvent(e));
  const merkleTree = buildMerkleTree(leaves);

  const record = {
    _version: STORE_VERSION,
    batch: {
      batchId,
      chain,
      workspaceId,
      createdAt,
      eventCount: list.length,
      root: merkleTree.root,
      eventIds,
      // Keep a canonical snapshot so verification doesn't depend on audit log
      // archival state. Events are stored in-order for index lookups.
      events: list,
    },
    merkleTree,
    receipt: null,
  };

  await withPathLock(anchorBatchPath(batchId), async () => {
    await writeJsonPath(anchorBatchPath(batchId), record);
  });

  await withPathLock(anchorIndexPath(), async () => {
    const idx = await readJsonPath(anchorIndexPath(), { _version: STORE_VERSION, byId: {} });
    if (!idx.byId) idx.byId = {};
    idx.byId[batchId] = {
      chain,
      workspaceId,
      createdAt,
      eventCount: list.length,
      root: merkleTree.root,
      submittedAt: null,
      txHash: null,
    };
    await writeJsonPath(anchorIndexPath(), idx);
  });

  return {
    batchId,
    root: merkleTree.root,
    eventCount: list.length,
    createdAt,
    merkleTree,
    eventIds,
  };
}

// ─── pluggable submitters ────────────────────────────────────────────────────

const submitters = new Map();

/**
 * Register a submitter under a chain name. Passing null/undefined removes it.
 * @param {string} chain
 * @param {((batch:object)=>Promise<object>)|null} fn
 */
export function registerAnchorSubmitter(chain, fn) {
  if (!chain || typeof chain !== "string") throw new Error("registerAnchorSubmitter: chain name required");
  if (fn == null) {
    submitters.delete(chain);
    return;
  }
  if (typeof fn !== "function") throw new Error("registerAnchorSubmitter: fn must be a function");
  submitters.set(chain, fn);
}

/**
 * Default mock submitter: produces a deterministic fake tx hash derived from
 * the Merkle root and the current timestamp, without any network I/O. Safe in
 * tests and when no external chain relay is configured.
 * @param {object} batch
 * @returns {Promise<{ txHash:string, chain:string, blockNumber:number, confirmedAt:string }>}
 */
export const mockSubmitter = async (batch) => {
  const payload = canonicalJson({
    root: batch?.batch?.root ?? null,
    batchId: batch?.batch?.batchId ?? null,
    ts: Date.now(),
  });
  const txHash = "0x" + sha256(payload);
  return {
    txHash,
    chain: batch?.batch?.chain || "mock",
    blockNumber: Math.floor(Date.now() / 1000),
    confirmedAt: new Date().toISOString(),
  };
};

/**
 * Optional HTTP submitter: POSTs the batch payload to the URL configured by
 * AUDIT_ANCHOR_HTTP_URL. Fails gracefully if fetch is unavailable or the
 * endpoint is unreachable.
 * @param {object} batch
 * @returns {Promise<{ txHash:string, chain:string, blockNumber?:number, confirmedAt:string }>}
 */
export const httpSubmitter = async (batch) => {
  const url = process.env.AUDIT_ANCHOR_HTTP_URL?.trim();
  if (!url) throw new Error("httpSubmitter: AUDIT_ANCHOR_HTTP_URL is not configured");
  if (typeof fetch !== "function") throw new Error("httpSubmitter: global fetch is not available");
  const body = JSON.stringify({
    batchId: batch?.batch?.batchId,
    root: batch?.batch?.root,
    chain: batch?.batch?.chain,
    eventCount: batch?.batch?.eventCount,
    createdAt: batch?.batch?.createdAt,
  });
  const headers = { "content-type": "application/json" };
  if (process.env.AUDIT_ANCHOR_HTTP_TOKEN) {
    headers.authorization = `Bearer ${process.env.AUDIT_ANCHOR_HTTP_TOKEN}`;
  }
  const resp = await fetch(url, { method: "POST", headers, body });
  if (!resp.ok) throw new Error(`httpSubmitter: HTTP ${resp.status}`);
  const json = await resp.json().catch(() => ({}));
  return {
    txHash: json.txHash || "0x" + sha256(body),
    chain: batch?.batch?.chain || "http",
    blockNumber: json.blockNumber,
    confirmedAt: json.confirmedAt || new Date().toISOString(),
  };
};

// Built-in submitters are registered eagerly. Callers may override.
registerAnchorSubmitter("mock", mockSubmitter);
registerAnchorSubmitter("http", httpSubmitter);

/**
 * Submit an anchor batch to an external chain. `submitter` may be a chain
 * name (resolved via the registry) or a function. The returned receipt is
 * persisted back onto the batch record so future reads expose it.
 *
 * @param {object|string} batchOrId - the batch record or a batchId to load
 * @param {string|function} [submitter]
 * @returns {Promise<{ txHash:string, chain:string, blockNumber?:number, confirmedAt:string }>}
 */
export async function submitAnchor(batchOrId, submitter) {
  const batchId = typeof batchOrId === "string" ? batchOrId : batchOrId?.batchId || batchOrId?.batch?.batchId;
  if (!batchId) throw new Error("submitAnchor: batchId required");

  const record = await readJsonPath(anchorBatchPath(batchId), null);
  if (!record || !record.batch) throw new Error(`submitAnchor: anchor ${batchId} not found`);

  let fn;
  if (typeof submitter === "function") {
    fn = submitter;
  } else {
    const name = typeof submitter === "string" && submitter ? submitter : record.batch.chain || "mock";
    fn = submitters.get(name);
    if (!fn) throw new Error(`submitAnchor: no submitter registered for chain "${name}"`);
  }

  const receipt = await fn(record);
  if (!receipt || typeof receipt.txHash !== "string") {
    throw new Error("submitAnchor: submitter returned invalid receipt");
  }
  const fullReceipt = {
    txHash: receipt.txHash,
    chain: receipt.chain || record.batch.chain,
    blockNumber: receipt.blockNumber ?? null,
    confirmedAt: receipt.confirmedAt || new Date().toISOString(),
  };

  await withPathLock(anchorBatchPath(batchId), async () => {
    const latest = await readJsonPath(anchorBatchPath(batchId), null);
    if (latest && latest.batch) {
      latest.receipt = fullReceipt;
      await writeJsonPath(anchorBatchPath(batchId), latest);
    }
  });

  await withPathLock(anchorIndexPath(), async () => {
    const idx = await readJsonPath(anchorIndexPath(), { _version: STORE_VERSION, byId: {} });
    if (!idx.byId) idx.byId = {};
    if (idx.byId[batchId]) {
      idx.byId[batchId].submittedAt = fullReceipt.confirmedAt;
      idx.byId[batchId].txHash = fullReceipt.txHash;
      idx.byId[batchId].chain = fullReceipt.chain;
    }
    await writeJsonPath(anchorIndexPath(), idx);
  });

  return fullReceipt;
}

/**
 * Retrieve a persisted anchor record by id.
 * @param {string} batchId
 * @returns {Promise<object|null>}
 */
export async function getAnchor(batchId) {
  if (!batchId) return null;
  const record = await readJsonPath(anchorBatchPath(batchId), null);
  if (!record || !record.batch) return null;
  return record;
}

/**
 * List anchors with optional filtering by chain and/or workspaceId. The
 * returned entries are index summaries, not full batch records; use
 * getAnchor(batchId) to fetch details.
 * @param {{ chain?:string, workspaceId?:string }} [filter]
 * @returns {Promise<Array<object>>}
 */
export async function listAnchors(filter = {}) {
  const idx = await readJsonPath(anchorIndexPath(), { _version: STORE_VERSION, byId: {} });
  const entries = Object.entries(idx.byId || {}).map(([batchId, meta]) => ({ batchId, ...meta }));
  let result = entries;
  if (filter.chain) result = result.filter((e) => e.chain === filter.chain);
  if (filter.workspaceId) result = result.filter((e) => e.workspaceId === filter.workspaceId);
  result.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return result;
}

/**
 * Produce a Merkle inclusion proof for a specific audit event inside an
 * anchored batch. Returns null if the event is not present in the batch.
 *
 * @param {string} eventId
 * @param {string} anchorId
 * @returns {Promise<null | {
 *   eventId:string, anchorId:string, chain:string, root:string,
 *   txHash:string|null, leaf:string, siblings:Array<{hash:string,position:string}>,
 *   event:object, verified:boolean
 * }>}
 */
export async function verifyAuditEvent(eventId, anchorId) {
  if (!eventId || !anchorId) return null;
  const record = await getAnchor(anchorId);
  if (!record || !record.batch || !record.merkleTree) return null;

  const { eventIds = [], events = [] } = record.batch;
  const leafIndex = eventIds.indexOf(eventId);
  if (leafIndex < 0) return null;

  const proof = generateMerkleProof(record.merkleTree, leafIndex);
  const event = events[leafIndex] ?? null;
  const leafHash = hashEvent(event);
  const verified = leafHash === proof.leaf && verifyMerkleProof(proof);

  return {
    eventId,
    anchorId,
    chain: record.batch.chain,
    root: proof.root,
    txHash: record.receipt?.txHash ?? null,
    leaf: proof.leaf,
    leafIndex,
    siblings: proof.siblings,
    event,
    verified,
  };
}

// ─── scheduled anchoring ─────────────────────────────────────────────────────

/**
 * Scheduler hook: query the audit log for recent events, group them into a
 * batch, create the anchor, and optionally submit it using the configured
 * chain. Intended for periodic invocation from lib/scheduler.js.
 *
 * @param {object} [options]
 * @param {number} [options.limit=500]
 * @param {string} [options.workspaceId]
 * @param {string} [options.chain="mock"]
 * @param {boolean} [options.submit=true]
 * @param {Array<object>} [options.events] - if supplied, skip auditQuery
 * @returns {Promise<{ batch:object, receipt:object|null, skipped?:boolean }>}
 */
export async function runAnchoringJob(options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 500;
  const chain = options.chain || "mock";
  const submit = options.submit !== false;
  const workspaceId = options.workspaceId || null;

  let events = options.events;
  if (!Array.isArray(events)) {
    try {
      const q = await queryAudit({ limit, workspaceId: workspaceId || undefined });
      events = q?.entries || [];
    } catch {
      events = [];
    }
  }

  if (events.length === 0) {
    return { batch: null, receipt: null, skipped: true };
  }

  const batch = await createAnchorBatch(events, { chain, workspaceId });
  let receipt = null;
  if (submit) {
    try {
      receipt = await submitAnchor(batch.batchId, chain);
    } catch (err) {
      // Submission failures are non-fatal for the job; the batch is already
      // persisted and can be retried later.
      receipt = { error: err.message || String(err) };
    }
  }
  return { batch, receipt };
}

// ─── test helpers ────────────────────────────────────────────────────────────

export const _internals = {
  anchorDir,
  anchorIndexPath,
  anchorBatchPath,
  submitters,
  hashPair,
};
