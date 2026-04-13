/**
 * Phase 60.2: On-demand heap snapshot + diff for memory leak detection.
 *
 * Uses Node's `v8.getHeapSnapshot()` to capture a streaming JSON snapshot
 * of the heap, then counts nodes by constructor/type to build cheap
 * summaries. Diffing compares two summaries and flags top growers — nodes
 * whose counts increased the most between snapshots.
 *
 * Storage layout (via json-path-store):
 *   data/heap-diff/<id>.json   — summary record (counts + metadata)
 *   data/heap-diff/_index.json — registry of known snapshot ids
 *
 * Full raw snapshots are NOT persisted by default (they can be hundreds of
 * MB); we store only the aggregated counts. Callers that need full
 * snapshots can pass `persistRaw: true` and accept the disk cost.
 */

import { randomUUID } from "crypto";
import { join } from "path";
import v8 from "v8";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Known node types (V8 heap snapshot spec) ──────────────────────────────

export const KNOWN_NODE_TYPES = [
  "hidden", "array", "string", "object", "code", "closure",
  "regexp", "number", "native", "synthetic", "concatenated string",
  "sliced string", "symbol", "bigint",
];

// ─── Path helpers ──────────────────────────────────────────────────────────

function sanitize(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function snapshotPath(id) {
  return join(getDataDir(), "heap-diff", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "heap-diff", "_index.json");
}

async function updateIndex(id, entry, remove = false) {
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { snapshots: [] });
    const list = Array.isArray(idx.snapshots) ? idx.snapshots : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { snapshots: filtered });
  });
}

// ─── Snapshot streaming helpers ────────────────────────────────────────────

/**
 * Drain a readable stream into a single Buffer. Used to read
 * v8.getHeapSnapshot() which returns a Readable.
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Aggregate a parsed V8 heap snapshot JSON into type-count buckets.
 * The snapshot format is documented at https://v8.dev/blog/heap-snapshots
 *
 * We rely on the index-based layout: `snapshot.meta.node_fields` tells us
 * what each field means, and `snapshot.strings` resolves the `type` field
 * into a string.
 */
export function summarizeHeapSnapshot(snapshotJson) {
  if (!snapshotJson || typeof snapshotJson !== "object") {
    return { totalNodes: 0, totalSize: 0, byType: {}, byConstructor: {} };
  }
  const meta = snapshotJson.snapshot?.meta || {};
  const nodeFields = Array.isArray(meta.node_fields) ? meta.node_fields : [
    "type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness",
  ];
  const nodeTypes = Array.isArray(meta.node_types) ? meta.node_types : [];
  const typeEnum = Array.isArray(nodeTypes[0]) ? nodeTypes[0] : KNOWN_NODE_TYPES;
  const nodes = Array.isArray(snapshotJson.nodes) ? snapshotJson.nodes : [];
  const strings = Array.isArray(snapshotJson.strings) ? snapshotJson.strings : [];
  const fieldCount = nodeFields.length;
  const typeIdx = nodeFields.indexOf("type");
  const nameIdx = nodeFields.indexOf("name");
  const sizeIdx = nodeFields.indexOf("self_size");

  const byType = {};
  const byConstructor = {};
  let totalNodes = 0;
  let totalSize = 0;

  for (let i = 0; i < nodes.length; i += fieldCount) {
    totalNodes += 1;
    const typeCode = nodes[i + typeIdx];
    const name = nodes[i + nameIdx];
    const selfSize = Number(nodes[i + sizeIdx]) || 0;
    totalSize += selfSize;
    const typeName = typeEnum[typeCode] || `type_${typeCode}`;
    byType[typeName] = (byType[typeName] || 0) + 1;
    // The `name` field is a string-table index for constructor names.
    if (typeName === "object" && typeof strings[name] === "string") {
      const ctor = strings[name] || "Object";
      byConstructor[ctor] = (byConstructor[ctor] || 0) + 1;
    }
  }

  return { totalNodes, totalSize, byType, byConstructor };
}

// ─── Snapshot capture ──────────────────────────────────────────────────────

/**
 * Capture a heap snapshot, summarize it, and persist the summary. Returns
 * the summary record (NOT the raw snapshot).
 */
export async function takeSnapshot(options = {}) {
  const label = typeof options.label === "string" ? options.label : "";
  const tag = typeof options.tag === "string" ? options.tag : null;
  const id = randomUUID();
  const at = new Date().toISOString();
  const stream = v8.getHeapSnapshot();
  const buf = await streamToBuffer(stream);
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    const err = new Error(`failed to parse heap snapshot: ${e.message}`);
    err.code = "PARSE_FAILED";
    throw err;
  }
  const summary = summarizeHeapSnapshot(parsed);
  const record = {
    id,
    label,
    tag,
    at,
    totalNodes: summary.totalNodes,
    totalSize: summary.totalSize,
    byType: summary.byType,
    byConstructor: summary.byConstructor,
    rawBytes: buf.length,
  };
  await writeJsonPath(snapshotPath(id), record);
  await updateIndex(id, {
    id,
    label,
    tag,
    at,
    totalNodes: record.totalNodes,
    totalSize: record.totalSize,
  });
  return record;
}

// ─── Retrieval ─────────────────────────────────────────────────────────────

export async function getSnapshot(id) {
  if (!id) return null;
  const data = await readJsonPath(snapshotPath(id), null);
  if (!data || !data.id) return null;
  return data;
}

export async function listSnapshots(filter = {}) {
  const idx = await readJsonPath(indexPath(), { snapshots: [] });
  const list = Array.isArray(idx.snapshots) ? idx.snapshots : [];
  const filtered = filter.tag
    ? list.filter((s) => s.tag === filter.tag)
    : list.slice();
  // newest first
  return filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function deleteSnapshot(id) {
  const rec = await getSnapshot(id);
  if (!rec) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(snapshotPath(id), { _deleted: true });
  await updateIndex(id, null, true);
  return { ok: true };
}

// ─── Diff ─────────────────────────────────────────────────────────────────

/**
 * Diff two snapshot summaries. Returns a record:
 *   {
 *     before: {id, at, totalNodes, totalSize},
 *     after:  {id, at, totalNodes, totalSize},
 *     delta:  {nodes, size},
 *     byType: { <typeName>: { before, after, delta } },
 *     byConstructor: { <ctorName>: { before, after, delta } },
 *     topGrowers: [ { name, kind, delta, before, after } ],
 *     flags: [ ... ],
 *   }
 */
export async function diffSnapshots(beforeId, afterId, options = {}) {
  const before = await getSnapshot(beforeId);
  if (!before) {
    const err = new Error(`snapshot ${beforeId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  const after = await getSnapshot(afterId);
  if (!after) {
    const err = new Error(`snapshot ${afterId} not found`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return diffSummaries(before, after, options);
}

export function diffSummaries(before, after, options = {}) {
  const topN = Math.max(1, Math.min(50, Number(options.topN) || 10));
  const minDelta = Number.isFinite(Number(options.minDelta)) ? Number(options.minDelta) : 10;

  const byType = {};
  const typeKeys = new Set([
    ...Object.keys(before.byType || {}),
    ...Object.keys(after.byType || {}),
  ]);
  for (const k of typeKeys) {
    const b = Number(before.byType?.[k] || 0);
    const a = Number(after.byType?.[k] || 0);
    byType[k] = { before: b, after: a, delta: a - b };
  }

  const byConstructor = {};
  const ctorKeys = new Set([
    ...Object.keys(before.byConstructor || {}),
    ...Object.keys(after.byConstructor || {}),
  ]);
  for (const k of ctorKeys) {
    const b = Number(before.byConstructor?.[k] || 0);
    const a = Number(after.byConstructor?.[k] || 0);
    byConstructor[k] = { before: b, after: a, delta: a - b };
  }

  // Top growers: combine both buckets, filter by minDelta, sort descending.
  const all = [
    ...Object.entries(byType).map(([name, v]) => ({ name, kind: "type", ...v })),
    ...Object.entries(byConstructor).map(([name, v]) => ({ name, kind: "constructor", ...v })),
  ];
  const topGrowers = all
    .filter((e) => e.delta >= minDelta)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, topN);

  // Flags: notable leak-ish signals.
  const flags = [];
  const sizeDelta = Number(after.totalSize || 0) - Number(before.totalSize || 0);
  const nodeDelta = Number(after.totalNodes || 0) - Number(before.totalNodes || 0);
  if (sizeDelta > 10 * 1024 * 1024) {
    flags.push({ kind: "size_growth", message: `heap grew ${Math.round(sizeDelta / 1024 / 1024)}MB` });
  }
  if (nodeDelta > 10_000) {
    flags.push({ kind: "node_growth", message: `${nodeDelta} more nodes` });
  }
  for (const kind of ["Array", "Object", "String"]) {
    const e = byConstructor[kind];
    if (e && e.delta > 1000) {
      flags.push({
        kind: "constructor_growth",
        message: `${kind} instances grew by ${e.delta}`,
        name: kind,
      });
    }
  }

  return {
    before: {
      id: before.id,
      at: before.at,
      totalNodes: before.totalNodes,
      totalSize: before.totalSize,
    },
    after: {
      id: after.id,
      at: after.at,
      totalNodes: after.totalNodes,
      totalSize: after.totalSize,
    },
    delta: { nodes: nodeDelta, size: sizeDelta },
    byType,
    byConstructor,
    topGrowers,
    flags,
  };
}

export const _internals = {
  snapshotPath,
  indexPath,
  streamToBuffer,
};
