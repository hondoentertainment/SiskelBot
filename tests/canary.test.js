/**
 * Phase 59.4: Canary deployment tests.
 *
 * Covers: phase constants, CRUD, lifecycle (start/pause/resume/abort/advance),
 * traffic routing determinism + percentage distribution, hash percentile
 * helpers, health sampling + summary, health gating, automatic progression,
 * rollback, side-by-side comparison, event history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate storage so tests don't contend with other suites.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-canary-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  CANARY_PHASES,
  createDeployment,
  getDeployment,
  listDeployments,
  deleteDeployment,
  startDeployment,
  pauseDeployment,
  resumeDeployment,
  abortDeployment,
  advancePhase,
  routeTraffic,
  hashToPercentile,
  routeByPercentage,
  recordHealthSample,
  getHealthSummary,
  checkHealthGate,
  autoAdvanceOrAbort,
  compareVersions,
  rollbackDeployment,
  recordDeploymentEvent,
  getDeploymentHistory,
} = await import("../lib/canary.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

// ─── Phase constants ───────────────────────────────────────────────────────

test("CANARY_PHASES has 5 phases starting at 1% and ending at 100%", () => {
  assert.equal(CANARY_PHASES.length, 5);
  assert.equal(CANARY_PHASES[0].percentage, 1);
  assert.equal(CANARY_PHASES[CANARY_PHASES.length - 1].percentage, 100);
  for (const p of CANARY_PHASES) {
    assert.ok(typeof p.name === "string" && p.name.length > 0);
    assert.ok(typeof p.percentage === "number");
    assert.ok(typeof p.minDurationMs === "number");
  }
});

// ─── CRUD ──────────────────────────────────────────────────────────────────

test("createDeployment persists a deployment with id, versions, phases", async () => {
  const dep = await createDeployment({
    name: "payments-v2",
    versionA: "1.4.0",
    versionB: "2.0.0",
  });
  assert.ok(dep.id);
  assert.equal(dep.name, "payments-v2");
  assert.equal(dep.versionA, "1.4.0");
  assert.equal(dep.versionB, "2.0.0");
  assert.equal(dep.status, "created");
  assert.equal(dep.currentPercentage, 0);
  assert.ok(Array.isArray(dep.phases));
  assert.equal(dep.phases.length, CANARY_PHASES.length);

  const fetched = await getDeployment(dep.id);
  assert.equal(fetched.id, dep.id);
});

test("listDeployments returns previously created deployments", async () => {
  await createDeployment({ name: "svc-a", versionA: "1", versionB: "2" });
  await createDeployment({ name: "svc-b", versionA: "1", versionB: "2" });
  const list = await listDeployments();
  assert.ok(list.length >= 2);
  assert.ok(list.some((d) => d.name === "svc-a"));
  assert.ok(list.some((d) => d.name === "svc-b"));
});

test("deleteDeployment removes a deployment", async () => {
  const dep = await createDeployment({ name: "tmp", versionA: "1", versionB: "2" });
  const res = await deleteDeployment(dep.id);
  assert.equal(res.ok, true);
  const fetched = await getDeployment(dep.id);
  assert.equal(fetched, null);
});

// ─── Lifecycle ─────────────────────────────────────────────────────────────

test("startDeployment sets status running and enters first phase", async () => {
  const dep = await createDeployment({ name: "start-test", versionA: "1", versionB: "2" });
  const started = await startDeployment(dep.id);
  assert.equal(started.status, "running");
  assert.equal(started.currentPhaseIndex, 0);
  assert.equal(started.currentPercentage, CANARY_PHASES[0].percentage);
  assert.ok(started.startedAt);
  assert.ok(started.phaseStartedAt);
});

test("advancePhase progresses through phases and completes at 100%", async () => {
  const dep = await createDeployment({ name: "advance-test", versionA: "1", versionB: "2" });
  await startDeployment(dep.id);
  for (let i = 1; i < CANARY_PHASES.length; i += 1) {
    const updated = await advancePhase(dep.id);
    if (i < CANARY_PHASES.length - 1) {
      assert.equal(updated.currentPhaseIndex, i);
      assert.equal(updated.currentPercentage, CANARY_PHASES[i].percentage);
      assert.equal(updated.status, "running");
    } else {
      assert.equal(updated.status, "completed");
      assert.equal(updated.currentPercentage, 100);
    }
  }
});

test("pauseDeployment and resumeDeployment toggle status", async () => {
  const dep = await createDeployment({ name: "pause-test", versionA: "1", versionB: "2" });
  await startDeployment(dep.id);
  const paused = await pauseDeployment(dep.id);
  assert.equal(paused.status, "paused");
  const resumed = await resumeDeployment(dep.id);
  assert.equal(resumed.status, "running");
});

test("abortDeployment records reason and sets traffic to 0%", async () => {
  const dep = await createDeployment({ name: "abort-test", versionA: "1", versionB: "2" });
  await startDeployment(dep.id);
  const aborted = await abortDeployment(dep.id, "manual rollback due to bug");
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.abortReason, "manual rollback due to bug");
  assert.equal(aborted.currentPercentage, 0);
  assert.ok(aborted.abortedAt);
});

// ─── Traffic routing ───────────────────────────────────────────────────────

test("routeTraffic is deterministic for the same requestKey", () => {
  const dep = { status: "running", currentPercentage: 50 };
  const first = routeTraffic(dep, "user-42");
  for (let i = 0; i < 20; i += 1) {
    assert.equal(routeTraffic(dep, "user-42"), first);
  }
});

test("routeTraffic approximates the phase percentage across many keys", () => {
  const dep = { status: "running", currentPercentage: 25 };
  let hitsB = 0;
  const total = 2000;
  for (let i = 0; i < total; i += 1) {
    if (routeTraffic(dep, `user-${i}`) === "B") hitsB += 1;
  }
  const fraction = hitsB / total;
  assert.ok(fraction > 0.18 && fraction < 0.32,
    `expected ~25% routed to B, got ${(fraction * 100).toFixed(1)}%`);
});

test("routeTraffic returns A when deployment not running", () => {
  assert.equal(routeTraffic({ status: "created", currentPercentage: 50 }, "user"), "A");
  assert.equal(routeTraffic({ status: "aborted", currentPercentage: 0 }, "user"), "A");
  assert.equal(routeTraffic({ status: "rolled_back", currentPercentage: 0 }, "user"), "A");
});

test("hashToPercentile returns integers in 0..99 and is stable", () => {
  for (let i = 0; i < 1000; i += 1) {
    const pct = hashToPercentile(`key-${i}`);
    assert.ok(Number.isInteger(pct));
    assert.ok(pct >= 0 && pct < 100);
  }
  assert.equal(hashToPercentile("stable-key"), hashToPercentile("stable-key"));
});

test("routeByPercentage handles edges and splits roughly evenly", () => {
  assert.equal(routeByPercentage("anything", 0), false);
  assert.equal(routeByPercentage("anything", 100), true);
  let hits = 0;
  const total = 2000;
  for (let i = 0; i < total; i += 1) {
    if (routeByPercentage(`u-${i}`, 50)) hits += 1;
  }
  const fraction = hits / total;
  assert.ok(fraction > 0.42 && fraction < 0.58,
    `expected ~50%, got ${(fraction * 100).toFixed(1)}%`);
});

// ─── Health samples ────────────────────────────────────────────────────────

test("recordHealthSample stores samples against the correct version", async () => {
  const dep = await createDeployment({ name: "health-basic", versionA: "1", versionB: "2" });
  await recordHealthSample(dep.id, "A", { latencyMs: 100, ok: true });
  await recordHealthSample(dep.id, "B", { latencyMs: 120, ok: true });
  await recordHealthSample(dep.id, "B", { latencyMs: 150, ok: false });
  const fresh = await getDeployment(dep.id);
  assert.equal(fresh.health.A.length, 1);
  assert.equal(fresh.health.B.length, 2);
});

test("getHealthSummary aggregates samples with percentiles", async () => {
  const dep = await createDeployment({ name: "health-agg", versionA: "1", versionB: "2" });
  for (const ms of [100, 120, 140, 160, 200, 300, 500, 800, 1200, 2000]) {
    await recordHealthSample(dep.id, "B", { latencyMs: ms, ok: true });
  }
  await recordHealthSample(dep.id, "B", { latencyMs: 150, ok: false });
  const summary = await getHealthSummary(dep.id);
  assert.equal(summary.B.samples, 11);
  assert.ok(summary.B.errorRate > 0 && summary.B.errorRate < 0.2);
  assert.ok(summary.B.p95LatencyMs >= 1000);
  assert.ok(summary.B.avgLatencyMs > 0);
});

test("checkHealthGate passes when few samples and when B healthy", async () => {
  const dep = await createDeployment({ name: "gate-pass", versionA: "1", versionB: "2" });
  // No samples yet — should pass with not_enough_samples.
  let gate = await checkHealthGate(dep.id);
  assert.equal(gate.passed, true);
  // Add mostly-successful B samples (exceeding minSamples default of 10).
  for (let i = 0; i < 30; i += 1) {
    await recordHealthSample(dep.id, "B", { latencyMs: 120, ok: true });
  }
  for (let i = 0; i < 30; i += 1) {
    await recordHealthSample(dep.id, "A", { latencyMs: 110, ok: true });
  }
  gate = await checkHealthGate(dep.id);
  assert.equal(gate.passed, true);
});

test("checkHealthGate fails when B error rate exceeds threshold", async () => {
  const dep = await createDeployment({
    name: "gate-fail",
    versionA: "1",
    versionB: "2",
    healthChecks: { maxErrorRate: 0.05, minSamples: 10, maxLatencyP95Ms: 10000, maxErrorRateDelta: 0.9 },
  });
  for (let i = 0; i < 18; i += 1) {
    await recordHealthSample(dep.id, "B", { latencyMs: 150, ok: true });
  }
  for (let i = 0; i < 12; i += 1) {
    await recordHealthSample(dep.id, "B", { latencyMs: 150, ok: false, errorKind: "5xx" });
  }
  const gate = await checkHealthGate(dep.id);
  assert.equal(gate.passed, false);
  assert.ok(/error rate/i.test(gate.reason));
});

// ─── Automatic progression ────────────────────────────────────────────────

test("autoAdvanceOrAbort advances the phase when healthy and duration elapsed", async () => {
  const dep = await createDeployment({
    name: "auto-advance",
    versionA: "1",
    versionB: "2",
    phases: [
      { name: "p1", percentage: 10, minDurationMs: 0 },
      { name: "p2", percentage: 50, minDurationMs: 0 },
      { name: "p3", percentage: 100, minDurationMs: 0 },
    ],
  });
  await startDeployment(dep.id);
  for (let i = 0; i < 20; i += 1) {
    await recordHealthSample(dep.id, "B", { latencyMs: 100, ok: true });
    await recordHealthSample(dep.id, "A", { latencyMs: 100, ok: true });
  }
  const result = await autoAdvanceOrAbort(dep.id);
  assert.equal(result.action, "advanced");
  assert.equal(result.deployment.currentPhaseIndex, 1);
  assert.equal(result.deployment.currentPercentage, 50);
});

test("autoAdvanceOrAbort aborts when B unhealthy", async () => {
  const dep = await createDeployment({
    name: "auto-abort",
    versionA: "1",
    versionB: "2",
    phases: [
      { name: "p1", percentage: 10, minDurationMs: 0 },
      { name: "p2", percentage: 100, minDurationMs: 0 },
    ],
    healthChecks: { maxErrorRate: 0.05, minSamples: 10, maxLatencyP95Ms: 10000, maxErrorRateDelta: 0.9 },
  });
  await startDeployment(dep.id);
  for (let i = 0; i < 20; i += 1) {
    await recordHealthSample(dep.id, "B", { latencyMs: 200, ok: false, errorKind: "5xx" });
  }
  const result = await autoAdvanceOrAbort(dep.id);
  assert.equal(result.action, "aborted");
  assert.equal(result.deployment.status, "aborted");
  assert.ok(result.deployment.abortReason);
});

test("autoAdvanceOrAbort waits when phase min duration not elapsed", async () => {
  const dep = await createDeployment({
    name: "auto-wait",
    versionA: "1",
    versionB: "2",
    phases: [
      { name: "p1", percentage: 10, minDurationMs: 60 * 60 * 1000 },
      { name: "p2", percentage: 100, minDurationMs: 0 },
    ],
  });
  await startDeployment(dep.id);
  for (let i = 0; i < 20; i += 1) {
    await recordHealthSample(dep.id, "B", { latencyMs: 100, ok: true });
  }
  const result = await autoAdvanceOrAbort(dep.id);
  assert.equal(result.action, "waiting");
  assert.equal(result.deployment.status, "running");
});

// ─── Rollback + comparison + history ──────────────────────────────────────

test("rollbackDeployment sets traffic to 0% and marks rolled_back", async () => {
  const dep = await createDeployment({ name: "rollback-test", versionA: "1", versionB: "2" });
  await startDeployment(dep.id);
  await advancePhase(dep.id); // move off the starting phase
  const rolled = await rollbackDeployment(dep.id);
  assert.equal(rolled.status, "rolled_back");
  assert.equal(rolled.currentPercentage, 0);
  const route = routeTraffic(rolled, "user-42");
  assert.equal(route, "A");
});

test("compareVersions returns side-by-side metrics and a winner", async () => {
  const dep = await createDeployment({ name: "compare-test", versionA: "1", versionB: "2" });
  for (let i = 0; i < 20; i += 1) {
    await recordHealthSample(dep.id, "A", { latencyMs: 200, ok: i % 10 === 0 ? false : true, satisfaction: 0.6 });
    await recordHealthSample(dep.id, "B", { latencyMs: 120, ok: true, satisfaction: 0.9 });
  }
  const fresh = await getDeployment(dep.id);
  const cmp = compareVersions(fresh);
  assert.ok(cmp.A.samples > 0);
  assert.ok(cmp.B.samples > 0);
  assert.ok("errorRateDelta" in cmp.diff);
  assert.ok("latencyP95Delta" in cmp.diff);
  assert.equal(cmp.winner, "B");
});

test("recordDeploymentEvent and getDeploymentHistory round trip", async () => {
  const dep = await createDeployment({ name: "history-test", versionA: "1", versionB: "2" });
  await recordDeploymentEvent(dep.id, { type: "note", data: { text: "looks good" } });
  const history = await getDeploymentHistory(dep.id);
  assert.ok(history.length >= 2); // created + note
  assert.ok(history.some((e) => e.type === "note"));
});
