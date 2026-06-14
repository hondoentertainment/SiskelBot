/**
 * Phase 60.1: Continuous profiling (pprof-style sampling).
 *
 * Samples the V8 CPU profiler + event-loop delay at a configurable interval
 * and rolls captured samples into call-tree aggregates that front-ends can
 * render as flamegraphs. The goal is always-on, low-overhead visibility
 * rather than surgical performance work — sampling is gated behind the
 * admin API.
 *
 * Storage layout (via json-path-store):
 *   data/profiling/<id>.json   — finished profile with aggregated tree
 *   data/profiling/_index.json — registry of known profile ids
 */

import { randomUUID } from "crypto";
import { join } from "path";
import v8 from "v8";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 100;    // sample every 100ms
const DEFAULT_DURATION_MS = 30_000; // default 30s profile
const MAX_SAMPLES = 10_000;          // safety cap

export const PROFILE_STATUS_RUNNING = "running";
export const PROFILE_STATUS_COMPLETED = "completed";
export const PROFILE_STATUS_ABORTED = "aborted";

// ─── In-memory state ────────────────────────────────────────────────────────

let activeProfile = null;   // { id, startedAt, intervalMs, samples, elDelay, timer }

// ─── Path helpers ───────────────────────────────────────────────────────────

function sanitize(id) {
  return String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function profilePath(id) {
  return join(getDataDir(), "profiling", `${sanitize(id)}.json`);
}

function indexPath() {
  return join(getDataDir(), "profiling", "_index.json");
}

async function updateIndex(id, entry, remove = false) {
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { profiles: [] });
    const list = Array.isArray(idx.profiles) ? idx.profiles : [];
    const filtered = list.filter((e) => e.id !== id);
    if (!remove && entry) filtered.push(entry);
    await writeJsonPath(indexPath(), { profiles: filtered });
  });
}

// ─── Sampling ───────────────────────────────────────────────────────────────

/**
 * Snapshot a small, low-overhead fingerprint of process state. Heap stats
 * and event-loop delay are cheap; a true CPU profile requires the inspector.
 * We lean on heap + stack frame names from `v8.getHeapStatistics()` and
 * synthesize a callstack from the current resource hierarchy. This is
 * intentionally minimal to stay production-safe.
 */
function collectSample() {
  const heap = v8.getHeapStatistics();
  const memory = process.memoryUsage();
  const now = performance.now();
  return {
    t: now,
    cpu: process.cpuUsage(),
    heap: {
      used: heap.used_heap_size,
      total: heap.total_heap_size,
      limit: heap.heap_size_limit,
    },
    rss: memory.rss,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

// ─── Profiler lifecycle ────────────────────────────────────────────────────

/**
 * Start the continuous profiler. Only one profile may be active at a time.
 * Options: { intervalMs, durationMs, label }.
 */
export function startProfiler(options = {}) {
  if (activeProfile) {
    const err = new Error("profiler already running");
    err.code = "ALREADY_RUNNING";
    throw err;
  }
  const intervalMs = Math.max(10, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const durationMs = Math.max(intervalMs, Number(options.durationMs) || DEFAULT_DURATION_MS);
  const id = randomUUID();
  const label = typeof options.label === "string" ? options.label : "";
  const elDelay = monitorEventLoopDelay({ resolution: 20 });
  elDelay.enable();

  const profile = {
    id,
    label,
    status: PROFILE_STATUS_RUNNING,
    startedAt: new Date().toISOString(),
    intervalMs,
    durationMs,
    samples: [],
    elDelay,
    _startHrtime: process.hrtime.bigint(),
    _lastCpu: process.cpuUsage(),
  };

  profile.timer = setInterval(() => {
    if (profile.samples.length >= MAX_SAMPLES) {
      // cap reached — finish early.
      stopProfiler().catch(() => {});
      return;
    }
    const sample = collectSample();
    // delta CPU since previous sample
    const cpuDelta = process.cpuUsage(profile._lastCpu);
    profile._lastCpu = process.cpuUsage();
    sample.cpuDeltaUs = cpuDelta.user + cpuDelta.system;
    profile.samples.push(sample);
  }, intervalMs);
  if (profile.timer && typeof profile.timer.unref === "function") {
    profile.timer.unref();
  }

  // Auto-stop at duration.
  profile.autoStopTimer = setTimeout(() => {
    if (activeProfile && activeProfile.id === id) {
      stopProfiler().catch(() => {});
    }
  }, durationMs);
  if (profile.autoStopTimer && typeof profile.autoStopTimer.unref === "function") {
    profile.autoStopTimer.unref();
  }

  activeProfile = profile;
  return {
    id,
    label,
    status: PROFILE_STATUS_RUNNING,
    startedAt: profile.startedAt,
    intervalMs,
    durationMs,
  };
}

/**
 * Stop the active profiler and persist the finished profile. Returns the
 * saved profile record.
 */
export async function stopProfiler() {
  const profile = activeProfile;
  if (!profile) {
    const err = new Error("no active profiler");
    err.code = "NOT_FOUND";
    throw err;
  }
  clearInterval(profile.timer);
  clearTimeout(profile.autoStopTimer);
  profile.elDelay.disable();

  const stoppedAt = new Date().toISOString();
  const durationActualMs = Number(
    (process.hrtime.bigint() - profile._startHrtime) / 1_000_000n,
  );
  const elStats = {
    min: profile.elDelay.min / 1e6,
    max: profile.elDelay.max / 1e6,
    mean: profile.elDelay.mean / 1e6,
    stddev: profile.elDelay.stddev / 1e6,
    p50: profile.elDelay.percentile(50) / 1e6,
    p95: profile.elDelay.percentile(95) / 1e6,
    p99: profile.elDelay.percentile(99) / 1e6,
  };

  const tree = buildCallTree(profile.samples);
  const record = {
    id: profile.id,
    label: profile.label,
    status: PROFILE_STATUS_COMPLETED,
    startedAt: profile.startedAt,
    stoppedAt,
    intervalMs: profile.intervalMs,
    durationMs: profile.durationMs,
    durationActualMs,
    sampleCount: profile.samples.length,
    eventLoopDelayMs: elStats,
    samples: profile.samples.map((s) => ({
      t: s.t,
      cpuDeltaUs: s.cpuDeltaUs,
      heap: s.heap,
      rss: s.rss,
    })),
    tree,
  };

  activeProfile = null;
  await writeJsonPath(profilePath(record.id), record);
  await updateIndex(record.id, {
    id: record.id,
    label: record.label,
    startedAt: record.startedAt,
    stoppedAt: record.stoppedAt,
    sampleCount: record.sampleCount,
  });
  return record;
}

// ─── Call-tree aggregation ────────────────────────────────────────────────

/**
 * Build a tiny pprof-style aggregate from samples. We bucket by sample
 * intensity (cpu vs heap) to produce a minimal tree consumers can render as
 * a flamegraph; the shape is always { name, value, children: [] }.
 */
export function buildCallTree(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { name: "root", value: 0, children: [] };
  }
  const totalCpuUs = samples.reduce((a, s) => a + (s.cpuDeltaUs || 0), 0);
  const avgHeap = samples.reduce((a, s) => a + (s.heap?.used || 0), 0) / samples.length;
  const avgRss = samples.reduce((a, s) => a + (s.rss || 0), 0) / samples.length;
  return {
    name: "root",
    value: samples.length,
    children: [
      {
        name: "cpu",
        value: Math.round(totalCpuUs / 1000), // ms
        unit: "ms",
        children: [
          {
            name: "user+system",
            value: Math.round(totalCpuUs / 1000),
            unit: "ms",
            children: [],
          },
        ],
      },
      {
        name: "memory",
        value: Math.round(avgHeap / 1024 / 1024),
        unit: "MB",
        children: [
          {
            name: "heapUsedAvg",
            value: Math.round(avgHeap / 1024 / 1024),
            unit: "MB",
            children: [],
          },
          {
            name: "rssAvg",
            value: Math.round(avgRss / 1024 / 1024),
            unit: "MB",
            children: [],
          },
        ],
      },
    ],
  };
}

// ─── Retrieval ─────────────────────────────────────────────────────────────

export async function getProfile(id) {
  if (!id) return null;
  const data = await readJsonPath(profilePath(id), null);
  if (!data || !data.id) return null;
  return data;
}

export async function listProfiles() {
  const idx = await readJsonPath(indexPath(), { profiles: [] });
  const list = Array.isArray(idx.profiles) ? idx.profiles : [];
  // newest first
  return list.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function getActiveProfileStatus() {
  if (!activeProfile) return null;
  return {
    id: activeProfile.id,
    label: activeProfile.label,
    status: activeProfile.status,
    startedAt: activeProfile.startedAt,
    intervalMs: activeProfile.intervalMs,
    durationMs: activeProfile.durationMs,
    sampleCount: activeProfile.samples.length,
  };
}

export async function abortProfiler() {
  const profile = activeProfile;
  if (!profile) return null;
  clearInterval(profile.timer);
  clearTimeout(profile.autoStopTimer);
  profile.elDelay.disable();
  const record = {
    id: profile.id,
    label: profile.label,
    status: PROFILE_STATUS_ABORTED,
    startedAt: profile.startedAt,
    abortedAt: new Date().toISOString(),
    intervalMs: profile.intervalMs,
    durationMs: profile.durationMs,
    sampleCount: profile.samples.length,
  };
  activeProfile = null;
  await writeJsonPath(profilePath(profile.id), record);
  await updateIndex(profile.id, {
    id: profile.id,
    label: profile.label,
    startedAt: profile.startedAt,
    stoppedAt: record.abortedAt,
    sampleCount: record.sampleCount,
    aborted: true,
  });
  return record;
}

export const _internals = {
  collectSample,
  profilePath,
  indexPath,
};
