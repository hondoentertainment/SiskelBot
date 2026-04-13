/**
 * Phase 60.3: Step-level latency rollup.
 *
 * Captures per-cortex and per-tool step latencies so operators can see which
 * agent step is slow in aggregate. Designed as a thin companion to
 * `lib/tracing-spans.js`: call `attachSpanListener` once at boot to harvest
 * latency from every finished span, or call `recordStep` manually from the
 * cortex dispatcher.
 *
 * Data layout:
 *   data/step-latency/rollup.json  — persisted rollup (persistFlush)
 *
 * All aggregation happens in-memory with a fixed ring buffer per
 * (cortex, tool) key for percentile computation. Writes are best-effort.
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

const MAX_SAMPLES_PER_KEY = Number(process.env.STEP_LATENCY_MAX_SAMPLES) || 5000;

// ─── State ─────────────────────────────────────────────────────────────────

/**
 * Map from "<cortex>::<tool>" -> {
 *   count,
 *   errors,
 *   totalMs,
 *   lastAt,
 *   samples: [latencyMs, ...]
 * }
 */
const keyState = new Map();

function stateKey(cortex, tool) {
  const c = cortex ? String(cortex) : "unknown";
  const t = tool ? String(tool) : "unknown";
  return `${c}::${t}`;
}

function ensureKey(cortex, tool) {
  const k = stateKey(cortex, tool);
  let entry = keyState.get(k);
  if (!entry) {
    entry = {
      cortex: cortex || "unknown",
      tool: tool || "unknown",
      count: 0,
      errors: 0,
      totalMs: 0,
      lastAt: null,
      samples: [],
    };
    keyState.set(k, entry);
  }
  return entry;
}

// ─── Recording ─────────────────────────────────────────────────────────────

/**
 * Record a single step measurement. Fields:
 *   cortex     — logical module that produced the step (e.g. "swarm", "agent")
 *   tool       — tool or operation name (e.g. "web_search")
 *   latencyMs  — duration in ms (required)
 *   ok         — boolean; default true
 *   at         — ISO timestamp; default now()
 */
export function recordStep({ cortex, tool, latencyMs, ok = true, at } = {}) {
  const ms = Number(latencyMs);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error("latencyMs must be a finite non-negative number");
  }
  const entry = ensureKey(cortex, tool);
  entry.count += 1;
  if (ok === false) entry.errors += 1;
  entry.totalMs += ms;
  entry.lastAt = at || new Date().toISOString();
  entry.samples.push(ms);
  if (entry.samples.length > MAX_SAMPLES_PER_KEY) {
    entry.samples.splice(0, entry.samples.length - MAX_SAMPLES_PER_KEY);
  }
  return {
    cortex: entry.cortex,
    tool: entry.tool,
    count: entry.count,
    latencyMs: ms,
  };
}

// ─── Span listener integration ────────────────────────────────────────────

/**
 * Harvest step latency from the tracing spans module. The `subscribe`
 * function should accept a callback `(span) => void` and invoke it once per
 * finished span. If the tracing system exposes a different hook, callers
 * can adapt it here.
 *
 * Expected span shape: { name, attributes, duration (ns|ms), status }.
 */
export function attachSpanListener(subscribe) {
  if (typeof subscribe !== "function") {
    throw new Error("subscribe must be a function");
  }
  return subscribe((span) => {
    try {
      const attrs = (span && (span.attributes || span._attributes)) || {};
      const cortex = attrs["siskel.cortex"] || attrs["siskel.module"] || span.scope || "unknown";
      const tool = attrs["siskel.tool"] || attrs["tool.name"] || span.name || "unknown";
      let durationMs = null;
      if (typeof span.durationMs === "number") {
        durationMs = span.durationMs;
      } else if (typeof span.duration === "number") {
        // OTel SpanReadable uses [seconds, nanos] HrTime; if we see a raw
        // number we assume ms for safety.
        durationMs = span.duration;
      } else if (Array.isArray(span.duration) && span.duration.length === 2) {
        const [s, ns] = span.duration;
        durationMs = s * 1000 + ns / 1e6;
      }
      if (durationMs == null || !Number.isFinite(durationMs)) return;
      const ok = !span.status || span.status.code !== 2; // 2=ERROR in OTel
      recordStep({ cortex, tool, latencyMs: durationMs, ok });
    } catch (_) {
      // Never let instrumentation break the app.
    }
  });
}

// ─── Percentiles ──────────────────────────────────────────────────────────

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

function summarizeEntry(entry) {
  const samples = entry.samples.slice().sort((a, b) => a - b);
  return {
    cortex: entry.cortex,
    tool: entry.tool,
    count: entry.count,
    errors: entry.errors,
    errorRate: entry.count > 0 ? entry.errors / entry.count : 0,
    avgMs: entry.count > 0 ? entry.totalMs / entry.count : 0,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    minMs: samples[0] || 0,
    maxMs: samples[samples.length - 1] || 0,
    lastAt: entry.lastAt,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────

/**
 * Global rollup: every (cortex, tool) combination observed, with summary.
 */
export function getLatencyReport() {
  const entries = [...keyState.values()].map(summarizeEntry);
  // Sort by count desc to keep the busiest steps at the top.
  entries.sort((a, b) => b.count - a.count);
  const totalCount = entries.reduce((a, b) => a + b.count, 0);
  return {
    generatedAt: new Date().toISOString(),
    totalKeys: entries.length,
    totalCount,
    steps: entries,
  };
}

/**
 * Breakdown by cortex — aggregates all tools that belong to a cortex.
 */
export function getBreakdownByCortex() {
  const byCortex = new Map();
  for (const entry of keyState.values()) {
    const key = entry.cortex;
    if (!byCortex.has(key)) {
      byCortex.set(key, {
        cortex: key,
        count: 0,
        errors: 0,
        totalMs: 0,
        samples: [],
        tools: new Set(),
      });
    }
    const bucket = byCortex.get(key);
    bucket.count += entry.count;
    bucket.errors += entry.errors;
    bucket.totalMs += entry.totalMs;
    bucket.samples.push(...entry.samples);
    bucket.tools.add(entry.tool);
  }
  const rows = [...byCortex.values()].map((b) => {
    const sorted = b.samples.slice().sort((a, c) => a - c);
    return {
      cortex: b.cortex,
      toolCount: b.tools.size,
      count: b.count,
      errors: b.errors,
      errorRate: b.count > 0 ? b.errors / b.count : 0,
      avgMs: b.count > 0 ? b.totalMs / b.count : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
    };
  });
  rows.sort((a, b) => b.count - a.count);
  return { generatedAt: new Date().toISOString(), cortexes: rows };
}

/**
 * Breakdown by tool — aggregates across all cortexes that used the tool.
 */
export function getBreakdownByTool() {
  const byTool = new Map();
  for (const entry of keyState.values()) {
    const key = entry.tool;
    if (!byTool.has(key)) {
      byTool.set(key, {
        tool: key,
        count: 0,
        errors: 0,
        totalMs: 0,
        samples: [],
        cortexes: new Set(),
      });
    }
    const bucket = byTool.get(key);
    bucket.count += entry.count;
    bucket.errors += entry.errors;
    bucket.totalMs += entry.totalMs;
    bucket.samples.push(...entry.samples);
    bucket.cortexes.add(entry.cortex);
  }
  const rows = [...byTool.values()].map((b) => {
    const sorted = b.samples.slice().sort((a, c) => a - c);
    return {
      tool: b.tool,
      cortexCount: b.cortexes.size,
      count: b.count,
      errors: b.errors,
      errorRate: b.count > 0 ? b.errors / b.count : 0,
      avgMs: b.count > 0 ? b.totalMs / b.count : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
    };
  });
  rows.sort((a, b) => b.count - a.count);
  return { generatedAt: new Date().toISOString(), tools: rows };
}

// ─── Persistence ──────────────────────────────────────────────────────────

function rollupPath() {
  return join(getDataDir(), "step-latency", "rollup.json");
}

/**
 * Flush the current rollup summary to disk. Intended for periodic saves so
 * rollups survive process restarts. Samples themselves are NOT persisted.
 */
export async function persistRollup() {
  return withPathLock(rollupPath(), async () => {
    const report = getLatencyReport();
    // Strip per-key samples; keep summaries only.
    await writeJsonPath(rollupPath(), report);
    return report;
  });
}

export async function loadPersistedRollup() {
  return readJsonPath(rollupPath(), { steps: [] });
}

// ─── Reset (tests) ────────────────────────────────────────────────────────

export function resetLatency() {
  keyState.clear();
}

export const _internals = {
  keyState,
  summarizeEntry,
  percentile,
  rollupPath,
};
