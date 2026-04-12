/**
 * Phase 60.4: LLM-adjacent log analysis.
 *
 * Lightweight, always-on anomaly summarization:
 *  - Ingest free-form log lines.
 *  - Normalize them into a template (strip timestamps, ids, numbers).
 *  - Cluster by template hash using a windowed sliding buffer.
 *  - Surface newly-appeared or spiking clusters as "anomalies".
 *
 * An LLM is NOT required to run — we pre-compute clusters + a reasonable
 * frequency ranking, and expose a `summarizeWithLlm` stub that can be
 * wired up later without breaking the cluster API.
 *
 * Data layout (via json-path-store):
 *   data/log-analysis/state.json — persisted cluster state (counts only)
 */

import { createHash } from "crypto";
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_CLUSTERS = Number(process.env.LOG_ANALYSIS_MAX_CLUSTERS) || 2000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000; // 15 minute rolling window
const DEFAULT_SPIKE_RATIO = 3;             // 3x the baseline rate = spike
const DEFAULT_NEW_CLUSTER_MIN_COUNT = 2;

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * clusterId -> {
 *   id, template, sample (latest raw line),
 *   firstSeen, lastSeen,
 *   totalCount,
 *   // ring buffer of recent event timestamps for rate calculations
 *   recent: [ts, ts, ...]
 * }
 */
const clusters = new Map();

// ─── Normalization ─────────────────────────────────────────────────────────

/**
 * Normalize a log line into a template by stripping high-cardinality tokens.
 * This turns "2024-11-05 12:00 user user-a3f failed in 123ms" into
 * "<DATE> <TIME> user <ID> failed in <NUM>ms".
 */
export function normalizeLine(line) {
  let s = String(line || "").trim();
  if (!s) return "";
  // timestamps (ISO, date-time, unix seconds)
  s = s.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, "<TS>");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "<DATE>");
  s = s.replace(/\b\d{2}:\d{2}(?::\d{2})?\b/g, "<TIME>");
  // UUIDs + hex ids
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>");
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, "<HEX>");
  // IP addresses
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<IP>");
  // IDs / tokens with mixed case + digits (common for user ids, keys)
  s = s.replace(/\b[a-zA-Z]+[-_]?[A-Za-z0-9]*\d+[A-Za-z0-9]*\b/g, "<ID>");
  // raw numbers (including decimals) are replaced last. Use a lookbehind
  // that allows word-boundary OR start-of-string, and do NOT require a
  // trailing word boundary so "123ms" -> "<NUM>ms".
  s = s.replace(/(?<![\w.])\d+(?:\.\d+)?/g, "<NUM>");
  // collapse repeated whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function hashTemplate(template) {
  return createHash("sha256").update(template).digest("hex").slice(0, 16);
}

// ─── Ingest ────────────────────────────────────────────────────────────────

/**
 * Ingest a batch of raw log lines. Each line may be a string or an object
 * with `{ message, at }`. Unknown shapes are coerced to string.
 *
 * Returns a summary { ingested, clusterCount }.
 */
export function ingestLogs(lines) {
  const arr = Array.isArray(lines) ? lines : [lines];
  let ingested = 0;
  for (const raw of arr) {
    const message = typeof raw === "string"
      ? raw
      : (raw && typeof raw === "object" ? String(raw.message || "") : String(raw));
    const at = typeof raw === "object" && raw && Number.isFinite(new Date(raw.at).getTime())
      ? new Date(raw.at).getTime()
      : Date.now();
    if (!message.trim()) continue;
    const template = normalizeLine(message);
    if (!template) continue;
    const id = hashTemplate(template);
    let entry = clusters.get(id);
    if (!entry) {
      if (clusters.size >= MAX_CLUSTERS) {
        // Evict least-recently-seen cluster to keep memory bounded.
        let oldestKey = null;
        let oldestTs = Infinity;
        for (const [k, v] of clusters) {
          if (v.lastSeen < oldestTs) { oldestTs = v.lastSeen; oldestKey = k; }
        }
        if (oldestKey) clusters.delete(oldestKey);
      }
      entry = {
        id,
        template,
        sample: message,
        firstSeen: at,
        lastSeen: at,
        totalCount: 0,
        recent: [],
      };
      clusters.set(id, entry);
    }
    entry.lastSeen = at;
    entry.sample = message;
    entry.totalCount += 1;
    entry.recent.push(at);
    // Keep recent buffer bounded to last DEFAULT_WINDOW_MS * 2.
    const cutoff = at - DEFAULT_WINDOW_MS * 2;
    if (entry.recent.length > 10_000) {
      entry.recent = entry.recent.filter((t) => t >= cutoff);
    }
    ingested += 1;
  }
  return { ingested, clusterCount: clusters.size };
}

// ─── Anomaly detection ─────────────────────────────────────────────────────

/**
 * Classify clusters as "new", "spiking", or "steady" within the given
 * rolling window. Returns a sorted list of anomalies, newest/spikiest first.
 */
export function getAnomalies(options = {}) {
  const now = Date.now();
  const windowMs = Number(options.windowMs) || DEFAULT_WINDOW_MS;
  const spikeRatio = Number(options.spikeRatio) || DEFAULT_SPIKE_RATIO;
  const newClusterMinCount = Number(options.newClusterMinCount) || DEFAULT_NEW_CLUSTER_MIN_COUNT;
  const recentCutoff = now - windowMs;
  const priorCutoff = now - windowMs * 2;

  const anomalies = [];
  for (const entry of clusters.values()) {
    const recentCount = entry.recent.reduce((n, t) => (t >= recentCutoff ? n + 1 : n), 0);
    const priorCount = entry.recent.reduce(
      (n, t) => (t >= priorCutoff && t < recentCutoff ? n + 1 : n),
      0,
    );
    let kind = "steady";
    let score = recentCount;
    // New: first seen inside window AND at least N events.
    if (entry.firstSeen >= recentCutoff && recentCount >= newClusterMinCount) {
      kind = "new";
      score = recentCount * 10;
    } else if (priorCount === 0 && recentCount >= newClusterMinCount) {
      // Hasn't been seen in the prior window — treat as new-ish.
      kind = "new";
      score = recentCount * 5;
    } else if (priorCount > 0) {
      const ratio = recentCount / priorCount;
      if (ratio >= spikeRatio) {
        kind = "spiking";
        score = recentCount * ratio;
      }
    }
    if (kind === "steady") continue;
    anomalies.push({
      id: entry.id,
      template: entry.template,
      sample: entry.sample,
      kind,
      recentCount,
      priorCount,
      ratio: priorCount > 0 ? recentCount / priorCount : null,
      firstSeen: new Date(entry.firstSeen).toISOString(),
      lastSeen: new Date(entry.lastSeen).toISOString(),
      score,
    });
  }
  anomalies.sort((a, b) => b.score - a.score);
  return { generatedAt: new Date(now).toISOString(), windowMs, anomalies };
}

// ─── Cluster summary ──────────────────────────────────────────────────────

/**
 * Cluster digest for dashboards. Sorted by totalCount desc.
 */
export function getClusterSummary(options = {}) {
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 100));
  const rows = [...clusters.values()].map((entry) => ({
    id: entry.id,
    template: entry.template,
    sample: entry.sample,
    firstSeen: new Date(entry.firstSeen).toISOString(),
    lastSeen: new Date(entry.lastSeen).toISOString(),
    totalCount: entry.totalCount,
    recentCount: entry.recent.length,
  }));
  rows.sort((a, b) => b.totalCount - a.totalCount);
  return {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    clusters: rows.slice(0, limit),
  };
}

// ─── LLM interface (stub) ─────────────────────────────────────────────────

/**
 * Produce a natural-language summary of the top anomalies. The default
 * implementation returns a deterministic string digest so callers can
 * integrate without requiring a backing LLM. Callers that have an LLM
 * available can replace this via `setLlmSummarizer`.
 */
let llmSummarizer = async (anomalies) => {
  if (!Array.isArray(anomalies) || anomalies.length === 0) {
    return "No anomalies detected in the current window.";
  }
  const header = `Detected ${anomalies.length} anomaly cluster(s).`;
  const lines = anomalies.slice(0, 10).map((a) => {
    const ratio = a.ratio != null ? ` (x${a.ratio.toFixed(1)})` : "";
    return `- [${a.kind}] ${a.recentCount} events${ratio}: ${a.template}`;
  });
  return [header, ...lines].join("\n");
};

export function setLlmSummarizer(fn) {
  if (typeof fn !== "function") throw new Error("summarizer must be a function");
  llmSummarizer = fn;
}

export async function summarizeWithLlm(options = {}) {
  const { anomalies } = getAnomalies(options);
  return {
    summary: await llmSummarizer(anomalies, options),
    anomalies,
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────

function statePath() {
  return join(getDataDir(), "log-analysis", "state.json");
}

export async function persistState() {
  return withPathLock(statePath(), async () => {
    const snapshot = {
      at: new Date().toISOString(),
      clusters: [...clusters.values()].map((c) => ({
        id: c.id,
        template: c.template,
        sample: c.sample,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        totalCount: c.totalCount,
      })),
    };
    await writeJsonPath(statePath(), snapshot);
    return snapshot;
  });
}

export async function loadPersistedState() {
  const data = await readJsonPath(statePath(), { clusters: [] });
  return Array.isArray(data.clusters) ? data : { clusters: [] };
}

// ─── Reset ────────────────────────────────────────────────────────────────

export function resetLogAnalysis() {
  clusters.clear();
}

export const _internals = {
  clusters,
  normalizeLine,
  hashTemplate,
  statePath,
};
