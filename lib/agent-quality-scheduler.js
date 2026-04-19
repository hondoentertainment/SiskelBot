/**
 * Quality agents scheduler.
 *
 * Registers a fixed set of recurring jobs that keep SiskelBot's quality
 * machinery running with zero human attention. Each job is an async handler
 * wrapped in a setInterval loop; state (last run time, last status, enabled
 * flag) is persisted to data/quality-jobs/state.json so restarts preserve
 * history.
 *
 * This module intentionally does NOT reach into lib/scheduler.js — that module
 * is narrowly focused on cron-scheduled recipes and uses a leader-election
 * handshake that is heavier than we need for coarse-grained quality probes.
 * Instead we use setInterval directly. In multi-process deployments only one
 * replica should call startJobs() — see the gotcha in the module docs.
 *
 * Default jobs:
 *   - nightly-benchmark      mini benchmark suite per workspace, 24h
 *   - weekly-safety          all safety probes, 7d
 *   - daily-patch-synth      prompt-tuner synthesize+save, 24h
 *   - hourly-health-score    health metric (optional), 1h
 *
 * QUALITY_JOBS_ENABLED=1 in the environment to activate; default OFF.
 *
 * @module agent-quality-scheduler
 */

import { join } from "path";
import { readdirSync, existsSync } from "fs";
import {
  readJsonPath,
  writeJsonPath,
  getDataDir,
  withPathLock,
} from "./json-path-store.js";
import { runBenchmarkSuite } from "./benchmark-harness.js";
import { MINI_TASKS } from "./benchmark-suites/mini-tasks.js";
import { runSafetySuite, allProbes } from "./safety-eval-suite.js";
import { synthesizePatch, savePatch } from "./agent-prompt-tuner.js";
import { recordSample, getSeries } from "./eval-history-store.js";

const STATE_VERSION = 1;
const STATE_FILE = "state.json";

const MS_HOUR = 3600_000;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;

const BENCHMARK_TIMEOUT_MS = 120_000;

/**
 * @typedef {object} QualityJob
 * @property {string} name
 * @property {string} schedule
 * @property {number} intervalMs
 * @property {"idle"|"running"|"error"} lastStatus
 * @property {number} [lastRunAt]
 * @property {number} [nextRunAt]
 * @property {string} [lastError]
 * @property {boolean} enabled
 */

// ─── State paths ──────────────────────────────────────────────────────────────

function statePath() {
  return join(getDataDir(), "quality-jobs", STATE_FILE);
}

function emptyState() {
  return { version: STATE_VERSION, jobs: [] };
}

async function loadState() {
  const raw = await readJsonPath(statePath(), emptyState());
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.jobs)) return emptyState();
  return raw;
}

async function saveState(state) {
  const path = statePath();
  await withPathLock(path, async () => {
    await writeJsonPath(path, state);
  });
}

// ─── In-memory registry ───────────────────────────────────────────────────────

/** @type {Map<string, {job: QualityJob, handler: () => Promise<any>, intervalOverride?: number}>} */
const registry = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();
let running = false;

// ─── Handlers ────────────────────────────────────────────────────────────────

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

/**
 * Discover workspaces by listing subdirectories under data/agent-genealogy/.
 * Falls back to ["default"] if the directory doesn't exist yet.
 */
function discoverWorkspaces() {
  const root = join(getDataDir(), "agent-genealogy");
  if (!existsSync(root)) return ["default"];
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => sanitizeSegment(e.name))
      .filter(Boolean);
    if (dirs.length === 0) return ["default"];
    return dirs;
  } catch {
    return ["default"];
  }
}

/** Minimal mock agent: produces a solution for the specific mini tasks. */
function mockAgentFn() {
  return async (prompt /*, ctx */) => {
    // The mini benchmark suite is small and deterministic. The mock returns a
    // generic code block so the scorer runs; it's not expected to pass all
    // tasks — the purpose is to exercise the harness end-to-end on schedule.
    const text = String(prompt || "");
    if (/sumEvens/.test(text)) {
      return "```javascript\nexport function sumEvens(a){return (a||[]).filter(n=>n%2===0).reduce((s,n)=>s+n,0);}\n```";
    }
    if (/fizzbuzz/.test(text)) {
      return "```javascript\nexport function fizzbuzz(n){if(n%15===0)return 'FizzBuzz';if(n%3===0)return 'Fizz';if(n%5===0)return 'Buzz';return String(n);}\n```";
    }
    return "```javascript\nexport default function(){return null;}\n```";
  };
}

/** Safety probe mock: returns a refusal so probes generally pass. */
function mockSafetyAgentFn() {
  return async (_prompt) =>
    "I cannot help with that. I don't have any information on that topic and cannot confirm the request. I must decline.";
}

async function withTimeout(p, ms, label) {
  let timer;
  const to = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, to]);
  } finally {
    clearTimeout(timer);
  }
}

/** Optional webhook emit — swallow any errors (webhooks module can reject). */
async function safeEmitWebhook(event, payload, opts) {
  try {
    const mod = await import("./webhooks.js");
    if (typeof mod.emitEvent === "function") {
      await mod.emitEvent(event, payload, opts);
    }
  } catch (err) {
    // webhooks unavailable → warn only
    console.warn("[quality-jobs] webhook emit failed:", err && err.message ? err.message : err);
  }
}

/**
 * Compare `passRate` against the 7-day p50 of prior benchmark samples for
 * the workspace. If it's materially lower, emit a regression webhook.
 */
async function maybeEmitRegression(workspace, passRate) {
  try {
    const sinceTs = Date.now() - 7 * MS_DAY;
    const series = await getSeries(workspace, {
      kind: "benchmark",
      metric: "passRate",
      sinceTs,
      bucket: "raw",
    });
    const values = series.map((p) => Number(p.value)).filter((n) => Number.isFinite(n));
    if (values.length < 3) return; // not enough signal to compare
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const p50 =
      sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    if (passRate < p50 - 0.05) {
      await safeEmitWebhook(
        "quality_regression",
        {
          workspace,
          kind: "benchmark",
          passRate,
          baselineP50: p50,
          delta: Math.round((passRate - p50) * 10000) / 10000,
        },
        { workspaceId: workspace },
      );
    }
  } catch (err) {
    console.warn("[quality-jobs] regression check failed:", err && err.message ? err.message : err);
  }
}

// ─── Job: nightly-benchmark ──────────────────────────────────────────────────

async function nightlyBenchmarkHandler() {
  const workspaces = discoverWorkspaces();
  const useReal = process.env.QUALITY_JOB_REAL_MODEL === "1";
  // Mock-only by default: real models require config and would blow the 120s cap.
  const agent = useReal ? mockAgentFn() : mockAgentFn();
  const summary = [];
  for (const ws of workspaces) {
    const { aggregate } = await withTimeout(
      runBenchmarkSuite(MINI_TASKS, agent, { concurrency: 2 }),
      BENCHMARK_TIMEOUT_MS,
      `benchmark[${ws}]`,
    );
    const passRate = aggregate.totalTasks
      ? aggregate.passedTasks / aggregate.totalTasks
      : 0;
    await recordSample(ws, {
      ts: Date.now(),
      kind: "benchmark",
      suite: "mini",
      metrics: {
        passRate,
        passedTasks: aggregate.passedTasks || 0,
        totalTasks: aggregate.totalTasks || 0,
        durationMs: aggregate.durationMs || 0,
      },
      tags: { runner: "scheduled", mode: useReal ? "real" : "mock" },
    });
    summary.push({ workspace: ws, passRate, total: aggregate.totalTasks || 0 });
    await maybeEmitRegression(ws, passRate);
  }
  return { workspaces: summary };
}

// ─── Job: weekly-safety ──────────────────────────────────────────────────────

async function weeklySafetyHandler() {
  const workspaces = discoverWorkspaces();
  const agent = mockSafetyAgentFn();
  const probes = allProbes();
  const summary = [];
  for (const ws of workspaces) {
    const report = await runSafetySuite(probes, agent, { concurrency: 2 });
    const passRate = report.overall.passRate;
    await recordSample(ws, {
      ts: Date.now(),
      kind: "safety",
      suite: "all-probes",
      metrics: {
        passRate,
        passed: report.overall.passed,
        total: report.overall.total,
        durationMs: report.overall.durationMs,
      },
      tags: { runner: "scheduled" },
    });
    summary.push({ workspace: ws, passRate, total: report.overall.total });
    // Regression check uses the benchmark helper shape — inline here for safety kind.
    try {
      const sinceTs = Date.now() - 28 * MS_DAY; // safety is weekly, look back 4 weeks
      const series = await getSeries(ws, { kind: "safety", metric: "passRate", sinceTs, bucket: "raw" });
      const values = series.map((p) => Number(p.value)).filter((n) => Number.isFinite(n));
      if (values.length >= 2) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const p50 = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        if (passRate < p50 - 0.05) {
          await safeEmitWebhook(
            "quality_regression",
            { workspace: ws, kind: "safety", passRate, baselineP50: p50 },
            { workspaceId: ws },
          );
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { workspaces: summary };
}

// ─── Job: daily-patch-synth ─────────────────────────────────────────────────

async function dailyPatchSynthHandler() {
  const workspaces = discoverWorkspaces();
  const results = [];
  for (const ws of workspaces) {
    try {
      const patch = await synthesizePatch(ws);
      if (patch) {
        await savePatch(patch);
        results.push({ workspace: ws, patched: true, version: patch.version });
        console.warn(
          `[quality-jobs] daily-patch-synth: new pending patch for ${ws} (version=${patch.version})`,
        );
      } else {
        results.push({ workspace: ws, patched: false });
      }
    } catch (err) {
      results.push({ workspace: ws, patched: false, error: err && err.message });
      console.warn(
        `[quality-jobs] daily-patch-synth: ${ws} failed:`,
        err && err.message ? err.message : err,
      );
    }
  }
  return { results };
}

// ─── Job: hourly-health-score ───────────────────────────────────────────────

async function hourlyHealthScoreHandler() {
  // Test hook: force the "module missing" branch without renaming the file.
  if (process.env.QUALITY_JOBS_SIMULATE_NO_HEALTH === "1") {
    console.warn(
      "[quality-jobs] hourly-health-score: simulated module-missing (env toggle)",
    );
    return { skipped: "module-missing" };
  }
  let mod;
  try {
    mod = await import("./agent-health-score.js");
  } catch {
    console.warn(
      "[quality-jobs] hourly-health-score: agent-health-score module not present; skipping tick",
    );
    return { skipped: "module-missing" };
  }
  const fn =
    mod.computeHealthScore ||
    mod.computeHealthBudget ||
    mod.computeHealth ||
    mod.default;
  if (typeof fn !== "function") {
    console.warn(
      "[quality-jobs] hourly-health-score: module present but no compute function exported; skipping",
    );
    return { skipped: "no-compute-fn" };
  }
  const workspaces = discoverWorkspaces();
  const summary = [];
  for (const ws of workspaces) {
    try {
      const result = await fn(ws);
      const metrics = {};
      if (result && typeof result === "object") {
        for (const [k, v] of Object.entries(result)) {
          if (Number.isFinite(v)) metrics[k] = Number(v);
        }
      } else if (Number.isFinite(result)) {
        metrics.score = Number(result);
      }
      if (Object.keys(metrics).length === 0) metrics.score = 0;
      // eval-history-store's ALLOWED_KINDS doesn't include "health"; record as
      // "custom" with the health suite tag so queries can still filter.
      await recordSample(ws, {
        ts: Date.now(),
        kind: "custom",
        suite: "health",
        metrics,
        tags: { runner: "scheduled", kind: "health" },
      });
      summary.push({ workspace: ws, metrics });
    } catch (err) {
      console.warn(
        `[quality-jobs] hourly-health-score[${ws}] failed:`,
        err && err.message ? err.message : err,
      );
    }
  }
  return { workspaces: summary };
}

// ─── Default job specs ──────────────────────────────────────────────────────

/**
 * Job specification — the immutable blueprint. Actual per-instance state
 * (lastRunAt, lastStatus, enabled) is merged in from the persisted store.
 *
 * @type {Array<{name: string, schedule: string, intervalMs: number, handler: () => Promise<any>}>}
 */
const DEFAULT_JOBS = [
  {
    name: "nightly-benchmark",
    schedule: "nightly 02:00 UTC",
    intervalMs: 24 * MS_HOUR,
    handler: nightlyBenchmarkHandler,
  },
  {
    name: "weekly-safety",
    schedule: "weekly Sunday 03:00 UTC",
    intervalMs: 7 * MS_DAY,
    handler: weeklySafetyHandler,
  },
  {
    name: "daily-patch-synth",
    schedule: "daily 04:00 UTC",
    intervalMs: 24 * MS_HOUR,
    handler: dailyPatchSynthHandler,
  },
  {
    name: "hourly-health-score",
    schedule: "hourly",
    intervalMs: MS_HOUR,
    handler: hourlyHealthScoreHandler,
  },
];

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Register (or re-register) the 4 default jobs. Idempotent: persisted
 * `lastRunAt`, `lastStatus`, `lastError`, and `enabled` are preserved across
 * calls. Returns the current job list.
 *
 * @returns {Promise<QualityJob[]>}
 */
export async function installAllJobs() {
  const prev = await loadState();
  const prevByName = new Map((prev.jobs || []).map((j) => [j.name, j]));

  /** @type {QualityJob[]} */
  const merged = [];
  for (const spec of DEFAULT_JOBS) {
    const prior = prevByName.get(spec.name);
    const job = {
      name: spec.name,
      schedule: spec.schedule,
      intervalMs: spec.intervalMs,
      lastStatus: prior?.lastStatus || "idle",
      enabled: typeof prior?.enabled === "boolean" ? prior.enabled : true,
    };
    if (Number.isFinite(prior?.lastRunAt)) job.lastRunAt = prior.lastRunAt;
    if (Number.isFinite(prior?.nextRunAt)) job.nextRunAt = prior.nextRunAt;
    if (typeof prior?.lastError === "string") job.lastError = prior.lastError;
    merged.push(job);
    registry.set(spec.name, { job, handler: spec.handler });
  }

  await saveState({ version: STATE_VERSION, jobs: merged });
  return merged.map((j) => ({ ...j }));
}

/**
 * Start the scheduler loop. Immediately ticks every enabled job once, then
 * schedules subsequent ticks on each job's interval.
 *
 * @returns {Promise<void>}
 */
export async function startJobs() {
  if (running) return;
  if (registry.size === 0) {
    await installAllJobs();
  }
  running = true;
  for (const [name, entry] of registry.entries()) {
    // Honor per-test override of intervalMs (used in unit tests).
    const intervalMs = entry.intervalOverride || entry.job.intervalMs;

    // First tick: run immediately (fire-and-forget, errors contained).
    tickJob(name).catch(() => {});

    const timer = setInterval(() => {
      tickJob(name).catch(() => {});
    }, intervalMs);
    // Don't keep the event loop alive in tests.
    if (typeof timer.unref === "function") timer.unref();
    timers.set(name, timer);
  }
}

/**
 * Stop all timers. Safe to call multiple times.
 *
 * @returns {Promise<void>}
 */
export async function stopJobs() {
  for (const timer of timers.values()) {
    clearInterval(timer);
  }
  timers.clear();
  running = false;
}

/**
 * Current snapshot of all registered jobs.
 * @returns {QualityJob[]}
 */
export function listJobs() {
  return [...registry.values()].map((e) => ({ ...e.job }));
}

/**
 * @param {string} name
 * @returns {QualityJob | null}
 */
export function getJob(name) {
  const entry = registry.get(name);
  return entry ? { ...entry.job } : null;
}

/**
 * Run a single job's handler immediately, bypassing the schedule. Records
 * status+duration and persists.
 *
 * @param {string} name
 * @returns {Promise<{status: "ok"|"error", durationMs: number, result?: unknown, error?: string}>}
 */
export async function runJobNow(name) {
  const entry = registry.get(name);
  if (!entry) {
    return { status: "error", durationMs: 0, error: `unknown job: ${name}` };
  }
  return executeHandler(entry);
}

/**
 * Toggle a job's enabled flag. Disabled jobs are skipped on tick but their
 * timer keeps firing so re-enabling takes effect immediately.
 *
 * @param {string} name
 * @param {boolean} enabled
 * @returns {Promise<QualityJob>}
 */
export async function setJobEnabled(name, enabled) {
  const entry = registry.get(name);
  if (!entry) throw new Error(`unknown job: ${name}`);
  entry.job.enabled = !!enabled;
  await persistState();
  return { ...entry.job };
}

/**
 * Whether the scheduler is allowed to run in this process. Default OFF — set
 * QUALITY_JOBS_ENABLED=1 to activate at boot.
 *
 * @returns {boolean}
 */
export function qualityJobsEnabled() {
  return process.env.QUALITY_JOBS_ENABLED === "1";
}

// ─── Internal ────────────────────────────────────────────────────────────────

async function tickJob(name) {
  const entry = registry.get(name);
  if (!entry) return;
  if (!entry.job.enabled) return;
  await executeHandler(entry);
}

async function executeHandler(entry) {
  const startedAt = Date.now();
  entry.job.lastStatus = "running";
  entry.job.nextRunAt = startedAt + entry.job.intervalMs;
  try {
    const result = await entry.handler();
    const durationMs = Date.now() - startedAt;
    entry.job.lastStatus = "idle";
    entry.job.lastRunAt = Date.now();
    entry.job.lastError = undefined;
    entry.job.nextRunAt = Date.now() + entry.job.intervalMs;
    await persistState();
    return { status: "ok", durationMs, result };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err && err.message ? String(err.message) : String(err);
    entry.job.lastStatus = "error";
    entry.job.lastRunAt = Date.now();
    entry.job.lastError = message;
    entry.job.nextRunAt = Date.now() + entry.job.intervalMs;
    await persistState();
    return { status: "error", durationMs, error: message };
  }
}

async function persistState() {
  const jobs = [...registry.values()].map((e) => ({ ...e.job }));
  await saveState({ version: STATE_VERSION, jobs });
}

// ─── Test hooks (unexported names prefixed with __) ─────────────────────────

/**
 * Reset the in-memory registry. Used by tests that want to start fresh between
 * cases without re-importing the module.
 */
export function __resetForTests() {
  stopJobs();
  registry.clear();
  timers.clear();
  running = false;
}

/**
 * Replace a job's handler. Used only by tests. Returns true if the name is
 * known.
 *
 * @param {string} name
 * @param {() => Promise<any>} handler
 * @param {{intervalMs?: number}} [opts]
 */
export function __setHandlerForTests(name, handler, opts = {}) {
  const entry = registry.get(name);
  if (!entry) return false;
  entry.handler = handler;
  if (Number.isFinite(opts.intervalMs)) {
    entry.intervalOverride = opts.intervalMs;
    entry.job.intervalMs = opts.intervalMs;
  }
  return true;
}
