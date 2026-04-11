// @ts-check
/**
 * Phase 60.1: Continuous profiling.
 *
 * Lightweight CPU / memory / async-stack sampling profiler. Samples are
 * periodically captured (using an injectable clock to keep tests
 * deterministic) and persisted to a JSON-backed store so profiles can
 * be inspected long after the sampler has stopped.
 *
 * Export surface:
 *   - startProfiler(opts)  -- begin a profiling session
 *   - stopProfiler(id)     -- stop a running session, return summary
 *   - getSamples(id)       -- raw samples for a session
 *   - getFlameData(id)     -- folded-stack flamegraph data
 *   - clearProfile(id)     -- delete one session (or all)
 *
 * @module continuous-profiling
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MAX_SAMPLES_PER_PROFILE = 10_000;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_DURATION_MS = 60_000;

function profilesPath() {
  return join(getDataDir(), "continuous-profiling.json");
}

/** @type {Map<string, { id: string, timer: any, opts: any, samples: any[], startedAt: string, stopAt?: string }>} */
const active = new Map();

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const data = await readJsonPath(profilesPath(), { version: STORE_VERSION, profiles: {} });
  if (!data.profiles || typeof data.profiles !== "object") data.profiles = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(profilesPath(), {
    version: STORE_VERSION,
    profiles: data.profiles || {},
  });
}

/* -------------------------------------------------------------------------- */
/* Sampling primitives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Capture a single sample. Uses real process stats when available, falls
 * back to synthetic deterministic values when tests stub the primitives.
 *
 * @param {object} [ctx]
 * @param {() => number} [ctx.hrtime]  ms since epoch-like reference
 * @param {() => NodeJS.MemoryUsage} [ctx.memoryUsage]
 * @param {() => string[]} [ctx.stack]
 * @returns {{ t: number, cpuMs: number, rss: number, heapUsed: number, heapTotal: number, external: number, stack: string[] }}
 */
export function captureSample(ctx = {}) {
  const nowFn = typeof ctx.hrtime === "function"
    ? ctx.hrtime
    : () => {
        const hr = process.hrtime();
        return hr[0] * 1000 + hr[1] / 1e6;
      };
  const memFn = typeof ctx.memoryUsage === "function"
    ? ctx.memoryUsage
    : () => process.memoryUsage();
  const stackFn = typeof ctx.stack === "function" ? ctx.stack : syntheticStack;

  const t = nowFn();
  let mem = /** @type {any} */ ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0 });
  try {
    const raw = memFn() || {};
    mem = {
      rss: Number(raw.rss) || 0,
      heapUsed: Number(raw.heapUsed) || 0,
      heapTotal: Number(raw.heapTotal) || 0,
      external: Number(raw.external) || 0,
    };
  } catch {
    // ignore
  }
  let stack = [];
  try {
    const s = stackFn();
    stack = Array.isArray(s) ? s.filter((x) => typeof x === "string") : [];
  } catch {
    stack = [];
  }
  // cpuMs is a rough placeholder: per-sample delta vs previous t. The caller
  // (sampler loop) computes the real delta; here we just return 0.
  return {
    t,
    cpuMs: 0,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    stack,
  };
}

/**
 * Best-effort stack collector using `new Error().stack`. Returns an
 * array of "functionName:file:line" frames (most-recent first), with
 * node_modules frames deduped.
 *
 * @returns {string[]}
 */
export function syntheticStack() {
  const e = new Error();
  const stack = String(e.stack || "");
  const frames = stack.split("\n").slice(2); // skip Error + this fn
  const out = [];
  for (const raw of frames) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    const frame = line.slice(3).replace(/\s+/g, " ").trim();
    if (!frame) continue;
    out.push(frame);
    if (out.length >= 20) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Session control                                                            */
/* -------------------------------------------------------------------------- */

let _idCounter = 0;
function genId(prefix = "prof") {
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
}

/**
 * @typedef {Object} StartProfilerOptions
 * @property {number} [intervalMs]    Sample every N ms. Default 100.
 * @property {number} [durationMs]    Auto-stop after this many ms. Default 60000.
 * @property {string} [name]          Human-readable session label.
 * @property {string} [kind]          "cpu" | "memory" | "async". Default "cpu".
 * @property {() => number} [clock]   Injectable clock (ms since reference).
 * @property {() => NodeJS.MemoryUsage} [memoryUsage]
 * @property {() => string[]} [stack]
 * @property {boolean} [autoStart]    Start the timer immediately. Default true.
 */

/**
 * Start a profiling session. Returns the session record. Timers are
 * only started when `autoStart` is true and an `intervalMs` is set.
 *
 * @param {StartProfilerOptions} [opts]
 * @returns {Promise<{ id: string, name: string, kind: string, intervalMs: number, durationMs: number, startedAt: string }>}
 */
export async function startProfiler(opts = {}) {
  const id = genId();
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
    ? Math.floor(opts.intervalMs)
    : DEFAULT_INTERVAL_MS;
  const durationMs = Number.isFinite(opts.durationMs) && opts.durationMs > 0
    ? Math.floor(opts.durationMs)
    : DEFAULT_DURATION_MS;
  const kind = typeof opts.kind === "string" ? opts.kind : "cpu";
  const name = typeof opts.name === "string" && opts.name.trim() ? opts.name : id;
  const startedAt = new Date().toISOString();

  const record = {
    id,
    name,
    kind,
    intervalMs,
    durationMs,
    startedAt,
    samples: /** @type {any[]} */ ([]),
    opts: { intervalMs, durationMs, kind, name },
  };

  active.set(id, { id, timer: null, opts, samples: record.samples, startedAt });

  const path = profilesPath();
  await withPathLock(path, async () => {
    const store = await loadStore();
    store.profiles[id] = {
      id,
      name,
      kind,
      intervalMs,
      durationMs,
      startedAt,
      stoppedAt: null,
      samples: [],
      summary: null,
    };
    await saveStore(store);
  });

  const autoStart = opts.autoStart !== false;
  if (autoStart && intervalMs > 0) {
    const clock = typeof opts.clock === "function" ? opts.clock : undefined;
    const memoryUsage = typeof opts.memoryUsage === "function" ? opts.memoryUsage : undefined;
    const stack = typeof opts.stack === "function" ? opts.stack : undefined;

    const sess = active.get(id);
    if (sess) {
      let lastT = 0;
      const tick = async () => {
        const cur = active.get(id);
        if (!cur) return;
        const sample = captureSample({ hrtime: clock, memoryUsage, stack });
        if (lastT > 0) {
          sample.cpuMs = Math.max(0, sample.t - lastT);
        }
        lastT = sample.t;
        cur.samples.push(sample);
        if (cur.samples.length > MAX_SAMPLES_PER_PROFILE) {
          cur.samples.splice(0, cur.samples.length - MAX_SAMPLES_PER_PROFILE);
        }
      };
      sess.timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      if (typeof sess.timer.unref === "function") sess.timer.unref();
      // Auto-stop timer.
      const stopTimer = setTimeout(() => {
        stopProfiler(id).catch(() => {});
      }, durationMs);
      if (typeof stopTimer.unref === "function") stopTimer.unref();
    }
  }

  return { id, name, kind, intervalMs, durationMs, startedAt };
}

/**
 * Append a single synthetic sample to an active session. Useful for
 * tests and for external samplers that don't want to rely on setInterval.
 *
 * @param {string} id
 * @param {object} sample
 */
export function pushSample(id, sample) {
  const sess = active.get(id);
  if (!sess) return false;
  if (!sample || typeof sample !== "object") return false;
  const normalized = {
    t: Number(sample.t) || Date.now(),
    cpuMs: Number(sample.cpuMs) || 0,
    rss: Number(sample.rss) || 0,
    heapUsed: Number(sample.heapUsed) || 0,
    heapTotal: Number(sample.heapTotal) || 0,
    external: Number(sample.external) || 0,
    stack: Array.isArray(sample.stack) ? sample.stack.filter((s) => typeof s === "string") : [],
  };
  sess.samples.push(normalized);
  if (sess.samples.length > MAX_SAMPLES_PER_PROFILE) {
    sess.samples.splice(0, sess.samples.length - MAX_SAMPLES_PER_PROFILE);
  }
  return true;
}

/**
 * Stop a running profiler session and persist the result.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function stopProfiler(id) {
  if (!id || typeof id !== "string") return null;
  const sess = active.get(id);
  if (!sess) {
    // Already stopped -- just return whatever's persisted.
    const store = await loadStore();
    return store.profiles[id] || null;
  }
  if (sess.timer) {
    clearInterval(sess.timer);
    sess.timer = null;
  }
  const stoppedAt = new Date().toISOString();
  const samples = sess.samples.slice();
  active.delete(id);

  const summary = summarizeSamples(samples);

  const path = profilesPath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    const existing = store.profiles[id] || {};
    const profile = {
      ...existing,
      id,
      stoppedAt,
      samples,
      summary,
      sampleCount: samples.length,
    };
    store.profiles[id] = profile;
    await saveStore(store);
    return profile;
  });
}

/**
 * Summarize sample statistics.
 *
 * @param {any[]} samples
 */
export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { count: 0, cpuTotalMs: 0, peakRss: 0, peakHeapUsed: 0, avgHeapUsed: 0 };
  }
  let cpuTotal = 0;
  let peakRss = 0;
  let peakHeap = 0;
  let heapSum = 0;
  for (const s of samples) {
    cpuTotal += Number(s.cpuMs) || 0;
    if ((Number(s.rss) || 0) > peakRss) peakRss = Number(s.rss) || 0;
    if ((Number(s.heapUsed) || 0) > peakHeap) peakHeap = Number(s.heapUsed) || 0;
    heapSum += Number(s.heapUsed) || 0;
  }
  return {
    count: samples.length,
    cpuTotalMs: Math.round(cpuTotal * 1000) / 1000,
    peakRss,
    peakHeapUsed: peakHeap,
    avgHeapUsed: Math.round(heapSum / samples.length),
  };
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Get raw samples for a session. Looks at in-memory state first, then
 * falls back to the persisted store.
 *
 * @param {string} id
 */
export async function getSamples(id) {
  if (!id || typeof id !== "string") return null;
  const sess = active.get(id);
  if (sess) {
    return { id, running: true, samples: sess.samples.slice() };
  }
  const store = await loadStore();
  const profile = store.profiles[id];
  if (!profile) return null;
  return { id, running: false, samples: Array.isArray(profile.samples) ? profile.samples : [] };
}

/**
 * Compute folded-stack flamegraph data:
 *   [{ stack: "a;b;c", count: N, cpuMs: N }, ...]
 *
 * Empty stacks are grouped under "(root)".
 *
 * @param {string} id
 */
export async function getFlameData(id) {
  const res = await getSamples(id);
  if (!res) return null;
  /** @type {Map<string, { count: number, cpuMs: number }>} */
  const buckets = new Map();
  for (const s of res.samples) {
    const frames = Array.isArray(s.stack) && s.stack.length > 0 ? s.stack : ["(root)"];
    // Reverse so root is on the left for flamegraph convention.
    const key = frames.slice().reverse().join(";");
    const b = buckets.get(key) || { count: 0, cpuMs: 0 };
    b.count += 1;
    b.cpuMs += Number(s.cpuMs) || 0;
    buckets.set(key, b);
  }
  const folded = [...buckets.entries()]
    .map(([stack, v]) => ({
      stack,
      count: v.count,
      cpuMs: Math.round(v.cpuMs * 1000) / 1000,
    }))
    .sort((a, b) => b.count - a.count);
  return { id, running: res.running, folded };
}

/**
 * Delete a stored profile (or every profile when id is omitted).
 *
 * @param {string} [id]
 */
export async function clearProfile(id) {
  const path = profilesPath();
  return withPathLock(path, async () => {
    const store = await loadStore();
    if (!id) {
      store.profiles = {};
      await saveStore(store);
      // Also stop every active session.
      for (const [k, sess] of active.entries()) {
        if (sess.timer) clearInterval(sess.timer);
        active.delete(k);
      }
      return { cleared: "all" };
    }
    delete store.profiles[id];
    await saveStore(store);
    const sess = active.get(id);
    if (sess) {
      if (sess.timer) clearInterval(sess.timer);
      active.delete(id);
    }
    return { cleared: id };
  });
}

/**
 * List every stored profile (running + persisted).
 */
export async function listProfiles() {
  const store = await loadStore();
  const persisted = Object.values(store.profiles || {});
  const running = [];
  for (const [id, sess] of active.entries()) {
    if (!store.profiles[id]) {
      running.push({ id, running: true, startedAt: sess.startedAt, sampleCount: sess.samples.length });
    }
  }
  return [
    ...persisted.map((p) => ({ ...p, running: active.has(/** @type {any} */ (p).id) })),
    ...running,
  ];
}
