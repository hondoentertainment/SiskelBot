/**
 * Phase 57.4: Lineage tracking (OpenLineage-compatible).
 *
 * Lightweight lineage event emitter. Events follow the OpenLineage 0.x shape
 * and describe a run of a "job" with zero or more "inputs" and "outputs".
 * Consumers can reconstruct a lineage graph by joining inputs to outputs
 * across events.
 *
 * Event shape:
 *   {
 *     eventType: "START" | "COMPLETE" | "ABORT" | "FAIL" | "RUNNING",
 *     eventTime: ISO8601,
 *     producer:  string URI,
 *     job:       { namespace, name, facets? },
 *     run:       { runId, facets? },
 *     inputs:    [{ namespace, name, facets? }],
 *     outputs:   [{ namespace, name, facets? }]
 *   }
 *
 * Storage:
 *   data/lineage/events.json      — ring buffer of events
 *   data/lineage/_index.json      — known jobs, datasets
 */
import { randomUUID } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

export const EVENT_TYPES = Object.freeze(["START", "COMPLETE", "ABORT", "FAIL", "RUNNING"]);
const DEFAULT_MAX_EVENTS = 20_000;

function eventsPath() {
  return join(getDataDir(), "lineage", "events.json");
}

function indexPath() {
  return join(getDataDir(), "lineage", "_index.json");
}

function sanitize(v) {
  return String(v || "").replace(/[^a-zA-Z0-9._\-:/]/g, "_").slice(0, 200) || "unknown";
}

function normalizeDataset(d) {
  if (!d || typeof d !== "object") return null;
  return {
    namespace: sanitize(d.namespace || "default"),
    name: sanitize(d.name || "unknown"),
    facets: d.facets && typeof d.facets === "object" ? d.facets : {},
  };
}

/**
 * Emit a lineage event. Accepts either a full OpenLineage-style event or a
 * compact shape with job.name + run.runId and arrays of dataset names.
 *
 * @param {{
 *   eventType?: string,
 *   eventTime?: string,
 *   producer?: string,
 *   job: { namespace?: string, name: string, facets?: object } | string,
 *   run: { runId: string, facets?: object } | string,
 *   inputs?: Array<object|string>,
 *   outputs?: Array<object|string>,
 * }} event
 * @returns {Promise<object>}
 */
export async function emitLineage(event) {
  if (!event || typeof event !== "object") throw new Error("event must be an object");
  if (!event.job) throw new Error("job is required");
  if (!event.run) throw new Error("run is required");

  const job = typeof event.job === "string"
    ? { namespace: "default", name: event.job, facets: {} }
    : {
        namespace: sanitize(event.job.namespace || "default"),
        name: sanitize(event.job.name),
        facets: event.job.facets && typeof event.job.facets === "object" ? event.job.facets : {},
      };
  const run = typeof event.run === "string"
    ? { runId: event.run, facets: {} }
    : {
        runId: String(event.run.runId || randomUUID()),
        facets: event.run.facets && typeof event.run.facets === "object" ? event.run.facets : {},
      };
  const eventType = EVENT_TYPES.includes(event.eventType) ? event.eventType : "RUNNING";
  const record = {
    eventType,
    eventTime: event.eventTime || new Date().toISOString(),
    producer: event.producer || "siskelbot/lineage",
    job,
    run,
    inputs: (Array.isArray(event.inputs) ? event.inputs : [])
      .map((d) => typeof d === "string" ? { namespace: "default", name: d, facets: {} } : normalizeDataset(d))
      .filter(Boolean),
    outputs: (Array.isArray(event.outputs) ? event.outputs : [])
      .map((d) => typeof d === "string" ? { namespace: "default", name: d, facets: {} } : normalizeDataset(d))
      .filter(Boolean),
  };

  await withPathLock(eventsPath(), async () => {
    const store = await readJsonPath(eventsPath(), { events: [] });
    const events = Array.isArray(store.events) ? store.events : [];
    events.push(record);
    const max = Number(process.env.LINEAGE_MAX_EVENTS) || DEFAULT_MAX_EVENTS;
    const trimmed = events.length > max ? events.slice(-max) : events;
    await writeJsonPath(eventsPath(), { events: trimmed });
  });

  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { jobs: [], datasets: [] });
    const jobKey = `${job.namespace}:${job.name}`;
    if (!idx.jobs.includes(jobKey)) idx.jobs.push(jobKey);
    for (const d of [...record.inputs, ...record.outputs]) {
      const dkey = `${d.namespace}:${d.name}`;
      if (!idx.datasets.includes(dkey)) idx.datasets.push(dkey);
    }
    await writeJsonPath(indexPath(), idx);
  });

  return record;
}

/**
 * Query lineage events.
 *
 * @param {{ jobName?: string, runId?: string, datasetName?: string, since?: string, until?: string, limit?: number }} filter
 */
export async function queryLineage(filter = {}) {
  const store = await readJsonPath(eventsPath(), { events: [] });
  const events = Array.isArray(store.events) ? store.events.slice() : [];
  const limit = Math.max(1, Math.min(10_000, Number(filter.limit) || 500));
  let out = events;
  if (filter.jobName) {
    out = out.filter((e) => e.job.name === filter.jobName);
  }
  if (filter.namespace) {
    out = out.filter((e) => e.job.namespace === filter.namespace);
  }
  if (filter.runId) {
    out = out.filter((e) => e.run.runId === filter.runId);
  }
  if (filter.datasetName) {
    out = out.filter((e) =>
      e.inputs.some((d) => d.name === filter.datasetName) ||
      e.outputs.some((d) => d.name === filter.datasetName),
    );
  }
  if (filter.since) {
    const s = Date.parse(filter.since);
    out = out.filter((e) => Date.parse(e.eventTime) >= s);
  }
  if (filter.until) {
    const u = Date.parse(filter.until);
    out = out.filter((e) => Date.parse(e.eventTime) <= u);
  }
  out.sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime));
  return { total: out.length, events: out.slice(-limit) };
}

/**
 * Build a lineage graph. Nodes are jobs + datasets; edges are
 * dataset→job (input) and job→dataset (output).
 *
 * @param {{ rootDataset?: string, maxDepth?: number }} [options]
 * @returns {Promise<{ nodes: Array, edges: Array }>}
 */
export async function getGraph(options = {}) {
  const { events } = await queryLineage({ limit: 10_000 });
  const nodes = new Map();
  const edges = [];
  function ensureNode(type, key, name, namespace) {
    if (!nodes.has(key)) {
      nodes.set(key, { id: key, type, name, namespace });
    }
  }
  for (const e of events) {
    const jobKey = `job:${e.job.namespace}:${e.job.name}`;
    ensureNode("job", jobKey, e.job.name, e.job.namespace);
    for (const d of e.inputs) {
      const dk = `dataset:${d.namespace}:${d.name}`;
      ensureNode("dataset", dk, d.name, d.namespace);
      edges.push({ from: dk, to: jobKey, kind: "input", eventTime: e.eventTime });
    }
    for (const d of e.outputs) {
      const dk = `dataset:${d.namespace}:${d.name}`;
      ensureNode("dataset", dk, d.name, d.namespace);
      edges.push({ from: jobKey, to: dk, kind: "output", eventTime: e.eventTime });
    }
  }
  // Optional filtering by ancestry from rootDataset.
  if (options.rootDataset) {
    const root = `dataset:${options.namespace || "default"}:${options.rootDataset}`;
    const maxDepth = Number(options.maxDepth) || 10;
    const keep = new Set();
    function walkBack(key, depth) {
      if (depth > maxDepth || keep.has(key)) return;
      keep.add(key);
      for (const e of edges) {
        if (e.to === key) walkBack(e.from, depth + 1);
      }
    }
    walkBack(root, 0);
    return {
      nodes: [...nodes.values()].filter((n) => keep.has(n.id)),
      edges: edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    };
  }
  return { nodes: [...nodes.values()], edges };
}

/**
 * Test helper.
 */
export async function _reset() {
  await writeJsonPath(eventsPath(), { events: [] });
  await writeJsonPath(indexPath(), { jobs: [], datasets: [] });
}

export const _internals = { normalizeDataset, eventsPath, indexPath };
