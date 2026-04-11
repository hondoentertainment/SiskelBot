// @ts-check
/**
 * Phase 60.4: LLM log analysis.
 *
 * Ingests a stream of log lines and surfaces anomalies:
 *   - Frequency spikes (count-per-window vs rolling baseline)
 *   - Error clustering by message signature
 *   - Per-window level summaries
 *
 * Logs are stored in a bounded in-memory ring backed by a JSON file
 * so restarts don't lose too much context. A deterministic clock can
 * be injected via `now` for testing.
 *
 * Export surface:
 *   - ingestLog(entry)
 *   - detectAnomalies({ windowMs?, baselineWindows?, spikeFactor? })
 *   - clusterErrors({ top? })
 *   - summarizeWindow({ windowMs? })
 *   - listAnomalies()
 *
 * @module log-analysis
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_LOGS = 10_000;
const MAX_ANOMALIES = 500;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_BASELINE_WINDOWS = 5;
const DEFAULT_SPIKE_FACTOR = 3;

function storePath() {
  return join(getDataDir(), "log-analysis.json");
}

let _counter = 0;
function genId(prefix = "log") {
  _counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_counter}`;
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    logs: [],
    anomalies: [],
  });
  if (!Array.isArray(data.logs)) data.logs = [];
  if (!Array.isArray(data.anomalies)) data.anomalies = [];
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    logs: Array.isArray(data.logs) ? data.logs.slice(-MAX_LOGS) : [],
    anomalies: Array.isArray(data.anomalies) ? data.anomalies.slice(-MAX_ANOMALIES) : [],
  });
}

/* -------------------------------------------------------------------------- */
/* Normalization and signatures                                               */
/* -------------------------------------------------------------------------- */

/**
 * Normalize an incoming log entry.
 *
 * @param {{ message?: string, level?: string, source?: string, timestamp?: string|number, metadata?: object }} entry
 */
export function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const message = typeof entry.message === "string" ? entry.message : String(entry.message || "");
  if (!message.trim()) return null;
  const level = typeof entry.level === "string" ? entry.level.toLowerCase() : "info";
  const source = typeof entry.source === "string" ? entry.source : "unknown";
  let ts;
  if (typeof entry.timestamp === "number") {
    ts = new Date(entry.timestamp).toISOString();
  } else if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    ts = Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  } else {
    ts = new Date().toISOString();
  }
  return {
    id: genId(),
    message,
    level,
    source,
    timestamp: ts,
    metadata: entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {},
  };
}

/**
 * Reduce a message to a stable signature by replacing dynamic content
 * (numbers, quoted strings, UUIDs, hex ids, IPs) with placeholders.
 *
 * @param {string} message
 */
export function signature(message) {
  if (!message || typeof message !== "string") return "";
  let out = message.toLowerCase();
  // UUIDs
  out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
  // Hex ids (8+ chars)
  out = out.replace(/\b[0-9a-f]{8,}\b/g, "<hex>");
  // IPv4
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>");
  // Numbers
  out = out.replace(/\b\d+(?:\.\d+)?\b/g, "<n>");
  // Quoted strings
  out = out.replace(/"([^"\\]|\\.)*"/g, '"<str>"');
  out = out.replace(/'([^'\\]|\\.)*'/g, "'<str>'");
  // Collapse whitespace
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Append a normalized log entry to the store.
 *
 * @param {object} entry
 */
export async function ingestLog(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) {
    throw new Error("log entry must include a non-empty message");
  }
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    data.logs.push(normalized);
    if (data.logs.length > MAX_LOGS) {
      data.logs.splice(0, data.logs.length - MAX_LOGS);
    }
    await saveStore(data);
    return normalized;
  });
}

/* -------------------------------------------------------------------------- */
/* Windowing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split logs into fixed-size time windows.
 *
 * @param {any[]} logs
 * @param {number} windowMs
 * @param {number} [now]
 */
export function bucketByWindow(logs, windowMs, now = Date.now()) {
  const size = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
  /** @type {Map<number, any[]>} */
  const buckets = new Map();
  for (const log of logs || []) {
    const t = Date.parse(log.timestamp || "");
    if (!Number.isFinite(t)) continue;
    const bucket = Math.floor(t / size) * size;
    const arr = buckets.get(bucket) || [];
    arr.push(log);
    buckets.set(bucket, arr);
  }
  // Ensure the current window exists even when empty.
  const current = Math.floor(now / size) * size;
  if (!buckets.has(current)) buckets.set(current, []);
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, logs]) => ({ start, end: start + size, count: logs.length, logs }));
}

/* -------------------------------------------------------------------------- */
/* Anomaly detection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Detect frequency spikes: the final bucket is considered a spike when
 * its count exceeds (baselineMean * spikeFactor). Flagged anomalies are
 * persisted so they can be listed later.
 *
 * @param {{ windowMs?: number, baselineWindows?: number, spikeFactor?: number, now?: number }} [opts]
 */
export async function detectAnomalies(opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? opts.windowMs
    : DEFAULT_WINDOW_MS;
  const baselineWindows = Number.isFinite(opts.baselineWindows) && opts.baselineWindows > 0
    ? Math.floor(opts.baselineWindows)
    : DEFAULT_BASELINE_WINDOWS;
  const spikeFactor = Number.isFinite(opts.spikeFactor) && opts.spikeFactor > 0
    ? opts.spikeFactor
    : DEFAULT_SPIKE_FACTOR;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const buckets = bucketByWindow(data.logs, windowMs, now);
    /** @type {Array<{ id: string, kind: string, detail: any, detectedAt: string }>} */
    const anomalies = [];
    if (buckets.length >= 2) {
      const last = buckets[buckets.length - 1];
      const base = buckets.slice(Math.max(0, buckets.length - 1 - baselineWindows), buckets.length - 1);
      if (base.length > 0) {
        const mean = base.reduce((acc, b) => acc + b.count, 0) / base.length;
        if (last.count > mean * spikeFactor && last.count >= 3) {
          anomalies.push({
            id: genId("anom"),
            kind: "frequency_spike",
            detail: {
              windowStart: last.start,
              windowEnd: last.end,
              count: last.count,
              baselineMean: Math.round(mean * 100) / 100,
              spikeFactor,
            },
            detectedAt: new Date(now).toISOString(),
          });
        }
      }
    }
    // Error-level spike
    const errorLogs = data.logs.filter((l) => l.level === "error" || l.level === "fatal");
    if (errorLogs.length > 0) {
      const errorBuckets = bucketByWindow(errorLogs, windowMs, now);
      const lastErr = errorBuckets[errorBuckets.length - 1];
      if (lastErr && lastErr.count >= 5) {
        anomalies.push({
          id: genId("anom"),
          kind: "error_burst",
          detail: {
            windowStart: lastErr.start,
            windowEnd: lastErr.end,
            count: lastErr.count,
          },
          detectedAt: new Date(now).toISOString(),
        });
      }
    }
    // Persist (append, bounded).
    if (anomalies.length > 0) {
      data.anomalies = [...(data.anomalies || []), ...anomalies].slice(-MAX_ANOMALIES);
      await saveStore(data);
    }
    return { anomalies, buckets: buckets.map((b) => ({ start: b.start, end: b.end, count: b.count })) };
  });
}

/**
 * Cluster error logs by signature, returning the top-N clusters.
 *
 * @param {{ top?: number }} [opts]
 */
export async function clusterErrors(opts = {}) {
  const top = Number.isFinite(opts.top) && opts.top > 0 ? Math.floor(opts.top) : 10;
  const data = await loadStore();
  const errorLogs = data.logs.filter((l) => l.level === "error" || l.level === "fatal");
  /** @type {Map<string, { signature: string, count: number, samples: any[], sources: Set<string> }>} */
  const clusters = new Map();
  for (const log of errorLogs) {
    const sig = signature(log.message);
    const cluster = clusters.get(sig) || { signature: sig, count: 0, samples: [], sources: new Set() };
    cluster.count += 1;
    if (cluster.samples.length < 3) cluster.samples.push(log);
    cluster.sources.add(log.source);
    clusters.set(sig, cluster);
  }
  const out = [...clusters.values()]
    .map((c) => ({
      signature: c.signature,
      count: c.count,
      sources: [...c.sources],
      samples: c.samples,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
  return { clusters: out, total: errorLogs.length };
}

/**
 * Summarize the most recent window.
 *
 * @param {{ windowMs?: number, now?: number }} [opts]
 */
export async function summarizeWindow(opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? opts.windowMs
    : DEFAULT_WINDOW_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const data = await loadStore();
  const cutoff = now - windowMs;
  const recent = data.logs.filter((l) => {
    const t = Date.parse(l.timestamp || "");
    return Number.isFinite(t) && t >= cutoff;
  });
  /** @type {Record<string, number>} */
  const byLevel = {};
  /** @type {Record<string, number>} */
  const bySource = {};
  for (const log of recent) {
    byLevel[log.level] = (byLevel[log.level] || 0) + 1;
    bySource[log.source] = (bySource[log.source] || 0) + 1;
  }
  return {
    windowMs,
    windowStart: cutoff,
    windowEnd: now,
    totalLogs: recent.length,
    byLevel,
    bySource,
  };
}

/**
 * Return every detected anomaly.
 */
export async function listAnomalies() {
  const data = await loadStore();
  return [...(data.anomalies || [])].sort((a, b) => {
    const ta = Date.parse(a.detectedAt || "") || 0;
    const tb = Date.parse(b.detectedAt || "") || 0;
    return tb - ta;
  });
}

/**
 * Drop every ingested log and anomaly.
 */
export async function clearLogs() {
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const count = data.logs.length;
    data.logs = [];
    data.anomalies = [];
    await saveStore(data);
    return { cleared: count };
  });
}
