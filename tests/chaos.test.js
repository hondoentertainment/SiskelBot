/**
 * Phase 59.1: Chaos engineering tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-chaos-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  registerFault,
  injectFault,
  removeFault,
  listActiveFaults,
  runChaosExperiment,
  listChaosExperiments,
} = await import("../lib/chaos.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("registerFault stores a latency fault", async () => {
  const f = await registerFault({
    target: "backend.chat",
    type: "latency",
    probability: 0.5,
    latencyMs: 150,
  });
  assert.equal(f.type, "latency");
  assert.equal(f.latencyMs, 150);
  assert.equal(f.active, true);
  assert.ok(f.id.startsWith("fault-"));
});

test("registerFault rejects invalid spec", async () => {
  await assert.rejects(() => registerFault(null));
  await assert.rejects(() => registerFault({ target: "x", type: "bogus", probability: 0.5 }));
  await assert.rejects(() => registerFault({ target: "", type: "error", probability: 0.5 }));
  await assert.rejects(() => registerFault({ target: "x", type: "error", probability: 2 }));
});

test("injectFault applies faults when random under probability", async () => {
  await registerFault({
    target: "always-latency",
    type: "latency",
    probability: 1.0,
    latencyMs: 200,
  });
  const decision = await injectFault("always-latency", {}, { random: () => 0.01 });
  assert.equal(decision.action, "latency");
  assert.equal(decision.delayMs, 200);
});

test("injectFault returns none when random above probability", async () => {
  await registerFault({
    target: "rare",
    type: "error",
    probability: 0.1,
    errorMessage: "boom",
  });
  const decision = await injectFault("rare", {}, { random: () => 0.99 });
  assert.equal(decision.action, "none");
});

test("injectFault returns error decision with message", async () => {
  await registerFault({
    target: "always-error",
    type: "error",
    probability: 1.0,
    errorMessage: "simulated 500",
  });
  const decision = await injectFault("always-error", {}, { random: () => 0 });
  assert.equal(decision.action, "error");
  assert.equal(decision.error, "simulated 500");
});

test("injectFault handles drop and partial types", async () => {
  await registerFault({ target: "drop-t", type: "drop", probability: 1 });
  const dDrop = await injectFault("drop-t", {}, { random: () => 0 });
  assert.equal(dDrop.action, "drop");

  await registerFault({ target: "partial-t", type: "partial", probability: 1, partialRatio: 0.3 });
  const dPartial = await injectFault("partial-t", {}, { random: () => 0 });
  assert.equal(dPartial.action, "partial");
  assert.equal(dPartial.ratio, 0.3);
});

test("injectFault with unknown target returns none", async () => {
  const d = await injectFault("no-target", {}, { random: () => 0 });
  assert.equal(d.action, "none");
});

test("removeFault clears the fault", async () => {
  const f = await registerFault({ target: "to-remove", type: "drop", probability: 1 });
  const removed = await removeFault(f.id);
  assert.ok(removed);
  const after = await injectFault("to-remove", {}, { random: () => 0 });
  assert.equal(after.action, "none");
  assert.equal(await removeFault("no-such"), null);
});

test("listActiveFaults filters by target", async () => {
  await registerFault({ target: "filter-a", type: "error", probability: 0.5 });
  await registerFault({ target: "filter-b", type: "error", probability: 0.5 });
  const a = await listActiveFaults("filter-a");
  assert.ok(a.every((f) => f.target === "filter-a"));
  const all = await listActiveFaults();
  assert.ok(all.length >= 2);
});

test("runChaosExperiment collects counts and cleans up", async () => {
  // Injectable random returns a rising sequence so we get deterministic mix.
  let i = 0;
  const seq = [0, 0.9, 0, 0.9, 0, 0.9, 0, 0.9];
  const random = () => seq[i++ % seq.length];
  const runs = [];
  const result = await runChaosExperiment(
    { target: "exp-target", type: "latency", probability: 0.5, latencyMs: 10 },
    (decision, idx) => {
      runs.push({ decision, idx });
      return decision.action;
    },
    { iterations: 8, random },
  );
  assert.equal(result.iterations, 8);
  assert.equal(runs.length, 8);
  // Half latency, half none (random alternates 0/0.9).
  assert.equal(result.counts.latency, 4);
  assert.equal(result.counts.none, 4);
  // Fault is cleaned up afterwards.
  const remaining = await listActiveFaults("exp-target");
  assert.equal(remaining.length, 0);

  const experiments = await listChaosExperiments();
  assert.ok(experiments.length >= 1);
});
