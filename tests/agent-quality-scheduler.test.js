/**
 * Unit tests for lib/agent-quality-scheduler.js.
 *
 * Uses an isolated STORAGE_PATH per run so the persisted state file cannot
 * leak between tests or between test runs. Exercises install/start/stop,
 * idempotency, runJobNow, failing handlers, disabled skipping, and the
 * graceful fallback when agent-health-score is absent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-quality-scheduler-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function freshModule() {
  // We keep a single module instance across tests (ES module cache), but reset
  // its in-memory state between cases via the exposed __resetForTests hook.
  const mod = await import("../lib/agent-quality-scheduler.js");
  if (typeof mod.__resetForTests === "function") {
    mod.__resetForTests();
  }
  return mod;
}

test("installAllJobs registers the 4 default jobs", async () => {
  const mod = await freshModule();
  const jobs = await mod.installAllJobs();
  assert.equal(jobs.length, 4);
  const names = jobs.map((j) => j.name).sort();
  assert.deepEqual(names, [
    "daily-patch-synth",
    "hourly-health-score",
    "nightly-benchmark",
    "weekly-safety",
  ]);
  for (const j of jobs) {
    assert.equal(typeof j.schedule, "string");
    assert.equal(typeof j.intervalMs, "number");
    assert.equal(j.enabled, true);
    assert.equal(j.lastStatus, "idle");
  }
});

test("installAllJobs is idempotent and preserves lastRunAt/enabled", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();

  // Override one handler with a fast no-op so we can record a lastRunAt.
  mod.__setHandlerForTests("hourly-health-score", async () => ({ ok: true }));
  await mod.runJobNow("hourly-health-score");
  await mod.setJobEnabled("nightly-benchmark", false);

  const before = mod.getJob("hourly-health-score");
  assert.ok(before.lastRunAt, "expected a lastRunAt after runJobNow");
  assert.equal(mod.getJob("nightly-benchmark").enabled, false);

  // Second install should not clobber runtime state.
  // __resetForTests would drop the registry; we DON'T call it here — we want
  // to prove installAllJobs itself preserves state across calls.
  const jobs2 = await mod.installAllJobs();
  assert.equal(jobs2.length, 4);
  const health = jobs2.find((j) => j.name === "hourly-health-score");
  assert.equal(health.lastRunAt, before.lastRunAt);
  const bench = jobs2.find((j) => j.name === "nightly-benchmark");
  assert.equal(bench.enabled, false);
});

test("startJobs + stopJobs round-trip; stop clears all timers", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  // Make every handler a no-op with a long interval so ticks don't fire
  // accidentally during the test window.
  for (const name of [
    "nightly-benchmark",
    "weekly-safety",
    "daily-patch-synth",
    "hourly-health-score",
  ]) {
    mod.__setHandlerForTests(name, async () => ({ ok: true }), {
      intervalMs: 60_000,
    });
  }
  await mod.startJobs();
  await sleep(20); // let the immediate first tick kick off

  await mod.stopJobs();
  // Capture lastRunAt for each job to prove no ticks fire post-stop.
  const snapshot = new Map(mod.listJobs().map((j) => [j.name, j.lastRunAt || 0]));
  await sleep(60);
  for (const j of mod.listJobs()) {
    assert.equal(
      j.lastRunAt || 0,
      snapshot.get(j.name),
      `job ${j.name} ticked after stopJobs`,
    );
  }
});

test("runJobNow invokes the handler and records status+duration", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  let called = 0;
  mod.__setHandlerForTests("nightly-benchmark", async () => {
    called++;
    await sleep(5);
    return { hello: "world" };
  });

  const outcome = await mod.runJobNow("nightly-benchmark");
  assert.equal(outcome.status, "ok");
  assert.ok(outcome.durationMs >= 0);
  assert.equal(called, 1);
  const job = mod.getJob("nightly-benchmark");
  assert.equal(job.lastStatus, "idle");
  assert.ok(job.lastRunAt);
  assert.equal(job.lastError, undefined);
});

test("failing handler records lastStatus 'error' + lastError but does not crash", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  mod.__setHandlerForTests("daily-patch-synth", async () => {
    throw new Error("kaboom");
  });

  const outcome = await mod.runJobNow("daily-patch-synth");
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /kaboom/);
  const job = mod.getJob("daily-patch-synth");
  assert.equal(job.lastStatus, "error");
  assert.match(job.lastError, /kaboom/);
  assert.ok(job.lastRunAt);
});

test("disabled job is skipped on tick (handler is not called)", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  let ticks = 0;
  for (const name of [
    "nightly-benchmark",
    "weekly-safety",
    "daily-patch-synth",
    "hourly-health-score",
  ]) {
    mod.__setHandlerForTests(name, async () => {
      if (name === "weekly-safety") ticks++;
      return { ok: true };
    }, { intervalMs: 60_000 });
  }
  await mod.setJobEnabled("weekly-safety", false);
  await mod.startJobs();
  await sleep(30);
  await mod.stopJobs();
  assert.equal(ticks, 0, "disabled job should not have ticked");
  // Re-enable, tick manually, confirm handler now runs.
  await mod.setJobEnabled("weekly-safety", true);
  await mod.runJobNow("weekly-safety");
  assert.equal(ticks, 1);
});

test("runJobNow on unknown job returns error without throwing", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  const outcome = await mod.runJobNow("does-not-exist");
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /unknown job/);
});

test("setJobEnabled on unknown job throws", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  await assert.rejects(() => mod.setJobEnabled("nope", false), /unknown job/);
});

test("qualityJobsEnabled reflects QUALITY_JOBS_ENABLED env var", async () => {
  const mod = await freshModule();
  const prior = process.env.QUALITY_JOBS_ENABLED;
  try {
    process.env.QUALITY_JOBS_ENABLED = "1";
    assert.equal(mod.qualityJobsEnabled(), true);
    process.env.QUALITY_JOBS_ENABLED = "0";
    assert.equal(mod.qualityJobsEnabled(), false);
    delete process.env.QUALITY_JOBS_ENABLED;
    assert.equal(mod.qualityJobsEnabled(), false);
  } finally {
    if (prior === undefined) delete process.env.QUALITY_JOBS_ENABLED;
    else process.env.QUALITY_JOBS_ENABLED = prior;
  }
});

test("hourly-health-score gracefully skips when module is missing", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  // Simulate "module missing" via an env toggle so the test doesn't depend on
  // whether lib/agent-health-score.js exists in this tree.
  const prior = process.env.QUALITY_JOBS_SIMULATE_NO_HEALTH;
  process.env.QUALITY_JOBS_SIMULATE_NO_HEALTH = "1";
  try {
    const outcome = await mod.runJobNow("hourly-health-score");
    assert.equal(outcome.status, "ok");
    assert.ok(outcome.result);
    assert.equal(outcome.result.skipped, "module-missing");
    const job = mod.getJob("hourly-health-score");
    assert.equal(job.lastStatus, "idle");
    assert.equal(job.lastError, undefined);
  } finally {
    if (prior === undefined) delete process.env.QUALITY_JOBS_SIMULATE_NO_HEALTH;
    else process.env.QUALITY_JOBS_SIMULATE_NO_HEALTH = prior;
  }
});

test("listJobs returns snapshots (mutations don't leak into registry)", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  const jobs = mod.listJobs();
  const target = jobs.find((j) => j.name === "hourly-health-score");
  const originalStatus = target.lastStatus;
  const originalEnabled = target.enabled;
  // Mutate the snapshot.
  target.lastStatus = "sentinel-status";
  target.enabled = !originalEnabled;
  const fresh = mod.listJobs().find((j) => j.name === "hourly-health-score");
  assert.equal(fresh.lastStatus, originalStatus);
  assert.equal(fresh.enabled, originalEnabled);
});

test("state is persisted to data/quality-jobs/state.json", async () => {
  const mod = await freshModule();
  await mod.installAllJobs();
  mod.__setHandlerForTests("nightly-benchmark", async () => ({ ok: true }));
  await mod.runJobNow("nightly-benchmark");

  const { readFileSync } = await import("fs");
  const statePath = join(process.env.STORAGE_PATH, "quality-jobs", "state.json");
  const raw = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(raw.version, 1);
  assert.ok(Array.isArray(raw.jobs));
  assert.equal(raw.jobs.length, 4);
  const bench = raw.jobs.find((j) => j.name === "nightly-benchmark");
  assert.ok(bench.lastRunAt, "lastRunAt should be persisted");
});
