/**
 * Unit tests for lib/agent-prompt-canary.js.
 *
 * Covers: startCanary validation, single-active invariant, deterministic
 * routing + distribution, outcome accumulation, decision logic across all
 * terminal branches, promote/rollback lifecycle, history persistence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const tmpRoot = mkdtempSync(join(tmpdir(), "siskel-canary-"));
process.env.STORAGE_PATH = tmpRoot;

test.after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Seed a pending patch via the public tuner API. */
async function seedPendingPatch(ws, version, content = "candidate patch content") {
  const { savePatch } = await import("../lib/agent-prompt-tuner.js");
  await savePatch({
    workspace: ws,
    version,
    content,
    generatedAt: Date.now(),
    basis: {
      failureCount: 0,
      genealogyCount: 0,
      conflictCount: 0,
      toolsFlagged: [],
      toolsPreferred: [],
    },
    status: "pending",
  });
}

async function seedAppliedPatch(ws, version, content = "applied baseline content") {
  const { savePatch } = await import("../lib/agent-prompt-tuner.js");
  await savePatch({
    workspace: ws,
    version,
    content,
    generatedAt: Date.now() - 1000,
    basis: {
      failureCount: 0,
      genealogyCount: 0,
      conflictCount: 0,
      toolsFlagged: [],
      toolsPreferred: [],
    },
    status: "applied",
    appliedAt: Date.now() - 900,
    appliedBy: "tester",
  });
}

test("canaryEnabled: default on, disabled via env", async () => {
  const { canaryEnabled } = await import("../lib/agent-prompt-canary.js");
  delete process.env.PROMPT_CANARY_ENABLED;
  assert.equal(canaryEnabled(), true);
  process.env.PROMPT_CANARY_ENABLED = "0";
  assert.equal(canaryEnabled(), false);
  delete process.env.PROMPT_CANARY_ENABLED;
});

test("startCanary: happy path persists deployment with defaults", async () => {
  const ws = `wsStart-${Date.now()}-happy`;
  await seedAppliedPatch(ws, "v-base");
  await seedPendingPatch(ws, "v-cand");

  const { startCanary, getActiveCanary } = await import("../lib/agent-prompt-canary.js");
  const d = await startCanary(ws, { candidateVersion: "v-cand" });
  assert.equal(d.workspace, ws);
  assert.equal(d.candidateVersion, "v-cand");
  assert.equal(d.baselineVersion, "v-base");
  assert.equal(d.trafficSplit, 0.1);
  assert.equal(d.minSamplesPerArm, 20);
  assert.equal(d.status, "active");
  assert.ok(d.endsAt > d.startedAt);
  assert.ok(Array.isArray(d.metrics) && d.metrics.length > 0);
  assert.ok(d.thresholds.passDelta >= 0 && d.thresholds.failDelta >= 0);

  const active = await getActiveCanary(ws);
  assert.ok(active);
  assert.equal(active.candidateVersion, "v-cand");
});

test("startCanary: rejects when a canary is already active", async () => {
  const ws = `wsStart-${Date.now()}-conflict`;
  await seedPendingPatch(ws, "v-a");
  await seedPendingPatch(ws, "v-b");

  const { startCanary } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, { candidateVersion: "v-a" });
  await assert.rejects(
    () => startCanary(ws, { candidateVersion: "v-b" }),
    /already active/i,
  );
});

test("startCanary: rejects unknown candidate version", async () => {
  const ws = `wsStart-${Date.now()}-unknown`;
  const { startCanary } = await import("../lib/agent-prompt-canary.js");
  await assert.rejects(
    () => startCanary(ws, { candidateVersion: "ghost" }),
    /not found/i,
  );
});

test("startCanary: rejects a rejected patch", async () => {
  const ws = `wsStart-${Date.now()}-rej`;
  const { savePatch } = await import("../lib/agent-prompt-tuner.js");
  await savePatch({
    workspace: ws,
    version: "v-rej",
    content: "nope",
    generatedAt: Date.now(),
    basis: {
      failureCount: 0, genealogyCount: 0, conflictCount: 0,
      toolsFlagged: [], toolsPreferred: [],
    },
    status: "rejected",
    appliedAt: Date.now(),
    appliedBy: "tester",
  });
  const { startCanary } = await import("../lib/agent-prompt-canary.js");
  await assert.rejects(
    () => startCanary(ws, { candidateVersion: "v-rej" }),
    /rejected/i,
  );
});

test("shouldUseCandidate: deterministic — same runId yields same arm repeatedly", async () => {
  const ws = `wsDet-${Date.now()}`;
  await seedPendingPatch(ws, "v-det");
  const { startCanary, shouldUseCandidate } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, { candidateVersion: "v-det", trafficSplit: 0.5 });

  for (const runId of ["run-1", "run-alpha", "run-xyz", "a".repeat(40)]) {
    const first = await shouldUseCandidate(ws, runId);
    for (let i = 0; i < 5; i++) {
      const again = await shouldUseCandidate(ws, runId);
      assert.equal(again, first, `runId ${runId} routing flipped on iteration ${i}`);
    }
  }
});

test("shouldUseCandidate: no active canary → false", async () => {
  const ws = `wsNone-${Date.now()}`;
  const { shouldUseCandidate } = await import("../lib/agent-prompt-canary.js");
  assert.equal(await shouldUseCandidate(ws, "run-1"), false);
});

test("shouldUseCandidate: distribution close to trafficSplit over 1000 runIds", async () => {
  const ws = `wsDist-${Date.now()}`;
  await seedPendingPatch(ws, "v-dist");
  const { startCanary, shouldUseCandidate } = await import("../lib/agent-prompt-canary.js");
  const trafficSplit = 0.3;
  await startCanary(ws, { candidateVersion: "v-dist", trafficSplit });

  let hits = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const runId = `run-${i}-${Math.random().toString(36).slice(2)}`;
    if (await shouldUseCandidate(ws, runId)) hits++;
  }
  const observed = hits / N;
  const tolerance = 0.05;
  assert.ok(
    Math.abs(observed - trafficSplit) <= tolerance,
    `expected ~${trafficSplit} candidate fraction, got ${observed.toFixed(3)} (hits=${hits}/${N})`,
  );
});

test("recordOutcome: accumulates counts and running mean correctly", async () => {
  const ws = `wsRec-${Date.now()}`;
  await seedPendingPatch(ws, "v-rec");
  const { startCanary, recordOutcome, getActiveCanary } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, {
    candidateVersion: "v-rec",
    metrics: ["feedbackUpRate"],
    minSamplesPerArm: 2,
  });

  await recordOutcome(ws, "candidate", "feedbackUpRate", 1);
  await recordOutcome(ws, "candidate", "feedbackUpRate", 0);
  await recordOutcome(ws, "candidate", "feedbackUpRate", 1);
  await recordOutcome(ws, "baseline", "feedbackUpRate", 0);
  await recordOutcome(ws, "baseline", "feedbackUpRate", 0);

  const active = await getActiveCanary(ws);
  const bucket = active.results.feedbackUpRate;
  assert.equal(bucket.candidateN, 3);
  assert.equal(bucket.baselineN, 2);
  // candidate mean = (1+0+1)/3 ≈ 0.6667
  assert.ok(Math.abs(bucket.candidateValue - 2 / 3) < 1e-9);
  assert.equal(bucket.baselineValue, 0);
});

test("recordOutcome: rejects invalid arm", async () => {
  const ws = `wsRecBad-${Date.now()}`;
  await seedPendingPatch(ws, "v-recbad");
  const { startCanary, recordOutcome } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, { candidateVersion: "v-recbad", metrics: ["m"] });
  await assert.rejects(() => recordOutcome(ws, "sidecar", "m", 1), /invalid arm/i);
});

test("evaluateCanary: continue when under-sampled", async () => {
  const ws = `wsEvalCont-${Date.now()}`;
  await seedPendingPatch(ws, "v-cont");
  const { startCanary, recordOutcome, evaluateCanary } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, {
    candidateVersion: "v-cont",
    metrics: ["feedbackUpRate"],
    minSamplesPerArm: 5,
  });
  // Only 2 candidate samples — under minSamples.
  await recordOutcome(ws, "candidate", "feedbackUpRate", 1);
  await recordOutcome(ws, "candidate", "feedbackUpRate", 1);
  const d = await evaluateCanary(ws);
  assert.equal(d.decision, "continue");
});

test("evaluateCanary: rollback on regression", async () => {
  const ws = `wsEvalReg-${Date.now()}`;
  await seedPendingPatch(ws, "v-reg");
  const { startCanary, recordOutcome, evaluateCanary } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, {
    candidateVersion: "v-reg",
    metrics: ["feedbackUpRate"],
    minSamplesPerArm: 3,
    thresholds: { passDelta: 0.02, failDelta: 0.05 },
  });
  // Candidate much worse than baseline.
  for (let i = 0; i < 5; i++) await recordOutcome(ws, "candidate", "feedbackUpRate", 0.3);
  for (let i = 0; i < 5; i++) await recordOutcome(ws, "baseline", "feedbackUpRate", 0.8);
  const d = await evaluateCanary(ws);
  assert.equal(d.decision, "rollback");
  assert.match(d.reason, /regression/i);
});

test("evaluateCanary: promote when all metrics pass", async () => {
  const ws = `wsEvalProm-${Date.now()}`;
  await seedPendingPatch(ws, "v-prom");
  const { startCanary, recordOutcome, evaluateCanary } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, {
    candidateVersion: "v-prom",
    metrics: ["feedbackUpRate"],
    minSamplesPerArm: 3,
    thresholds: { passDelta: 0.02, failDelta: 0.05 },
  });
  for (let i = 0; i < 5; i++) await recordOutcome(ws, "candidate", "feedbackUpRate", 0.8);
  for (let i = 0; i < 5; i++) await recordOutcome(ws, "baseline", "feedbackUpRate", 0.6);
  const d = await evaluateCanary(ws);
  assert.equal(d.decision, "promote");
});

test("evaluateCanary: expired with insufficient samples → rollback", async () => {
  const ws = `wsEvalExp-${Date.now()}`;
  await seedPendingPatch(ws, "v-exp");
  const { startCanary, recordOutcome, evaluateCanary } = await import("../lib/agent-prompt-canary.js");
  // durationHours near-zero so endsAt is already in the past.
  await startCanary(ws, {
    candidateVersion: "v-exp",
    metrics: ["feedbackUpRate"],
    minSamplesPerArm: 5,
    durationHours: 0.0001, // ~360ms
  });
  await recordOutcome(ws, "candidate", "feedbackUpRate", 1);
  // wait for deadline to pass
  await new Promise((r) => setTimeout(r, 500));
  const d = await evaluateCanary(ws);
  assert.equal(d.decision, "rollback");
  assert.match(d.reason, /insufficient samples/i);
});

test("promoteCanary: marks promoted and moves to history", async () => {
  const ws = `wsProm-${Date.now()}`;
  await seedPendingPatch(ws, "v-p");
  const { startCanary, promoteCanary, listCanaries, getActiveCanary } =
    await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, { candidateVersion: "v-p" });

  const result = await promoteCanary(ws);
  assert.equal(result.status, "promoted");

  const active = await getActiveCanary(ws);
  assert.equal(active, null);

  const hist = await listCanaries(ws, { status: "promoted" });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].candidateVersion, "v-p");
  assert.ok(hist[0].decidedAt);
});

test("rollbackCanary: marks rolled_back with reason and moves to history", async () => {
  const ws = `wsRb-${Date.now()}`;
  await seedPendingPatch(ws, "v-rb");
  const { startCanary, rollbackCanary, listCanaries } =
    await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, { candidateVersion: "v-rb" });

  const result = await rollbackCanary(ws, "regression on feedbackUpRate");
  assert.equal(result.status, "rolled_back");
  assert.equal(result.decisionReason, "regression on feedbackUpRate");

  const hist = await listCanaries(ws, { status: "rolled_back" });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].decisionReason, "regression on feedbackUpRate");
});

test("promoteCanary: throws when no active canary", async () => {
  const ws = `wsNoActive-${Date.now()}`;
  const { promoteCanary } = await import("../lib/agent-prompt-canary.js");
  await assert.rejects(() => promoteCanary(ws), /no active canary/i);
});

test("getCanary: returns historical canary by candidateVersion", async () => {
  const ws = `wsGetHist-${Date.now()}`;
  await seedPendingPatch(ws, "v-hist");
  const { startCanary, promoteCanary, getCanary } = await import("../lib/agent-prompt-canary.js");
  await startCanary(ws, { candidateVersion: "v-hist" });
  await promoteCanary(ws);
  const got = await getCanary(ws, "v-hist");
  assert.ok(got);
  assert.equal(got.candidateVersion, "v-hist");
  assert.equal(got.status, "promoted");
});
