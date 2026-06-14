/**
 * Phase 45.2: Differential privacy tests.
 *
 * Covers the Gaussian and Laplace mechanisms, L2 gradient clipping,
 * privacy budget composition, DP-SGD end-to-end, the persistent privacy
 * accountant, and the query-leak analyzer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use an isolated data directory so the persistent accountant does not
// interfere with other tests or pollute the project data folder.
const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-dp-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  addGaussianNoise,
  addLaplaceNoise,
  clipGradients,
  computePrivacyBudget,
  dpSGDStep,
  getPrivacyAccountant,
  listPrivacyAccountants,
  analyzePrivacyLeak,
  _internals,
} = await import("../lib/differential-privacy.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// ---- Gaussian mechanism ----

test("addGaussianNoise returns a vector of the same length", () => {
  const out = addGaussianNoise([1, 2, 3, 4], 0.1);
  assert.equal(out.length, 4);
});

test("addGaussianNoise with sigma=0 returns the vector unchanged", () => {
  const out = addGaussianNoise([1, 2, 3], 0);
  assert.deepEqual(out, [1, 2, 3]);
});

test("addGaussianNoise is roughly zero-mean over many samples", () => {
  const N = 2000;
  const zeros = new Array(N).fill(0);
  const noisy = addGaussianNoise(zeros, 1);
  const mean = noisy.reduce((s, v) => s + v, 0) / N;
  const variance = noisy.reduce((s, v) => s + v * v, 0) / N - mean * mean;
  // With N=2000 and sigma=1, the sample mean stays well under 0.2 in practice.
  assert.ok(Math.abs(mean) < 0.2, `mean ${mean} not near zero`);
  // Variance should be close to 1; allow generous slack.
  assert.ok(variance > 0.6 && variance < 1.6, `variance ${variance} out of range`);
});

test("addGaussianNoise handles non-array inputs and bad sigma", () => {
  assert.deepEqual(addGaussianNoise(null, 0.1), []);
  // Negative sigma coerced to 0.
  assert.deepEqual(addGaussianNoise([1, 2, 3], -5), [1, 2, 3]);
  // Non-finite entries coerced to 0 before adding noise.
  const out = addGaussianNoise([Number.NaN, Number.POSITIVE_INFINITY], 0);
  assert.deepEqual(out, [0, 0]);
});

// ---- Laplace mechanism ----

test("addLaplaceNoise returns a vector of the same length", () => {
  const out = addLaplaceNoise([10, 20, 30], 0.5);
  assert.equal(out.length, 3);
});

test("addLaplaceNoise with scale=0 returns the vector unchanged", () => {
  assert.deepEqual(addLaplaceNoise([1, 2, 3], 0), [1, 2, 3]);
});

test("addLaplaceNoise variance ~= 2 * scale^2", () => {
  const N = 4000;
  const zeros = new Array(N).fill(0);
  const scale = 2;
  const noisy = addLaplaceNoise(zeros, scale);
  const mean = noisy.reduce((s, v) => s + v, 0) / N;
  const variance = noisy.reduce((s, v) => s + (v - mean) * (v - mean), 0) / N;
  // Analytic variance is 2*b^2 = 8. Accept 4..14 for sampling noise.
  assert.ok(variance > 4 && variance < 14, `variance ${variance} out of range`);
});

// ---- Clipping ----

test("clipGradients leaves a short-norm vector untouched", () => {
  const r = clipGradients([0.1, 0.1, 0.1], 1);
  assert.deepEqual(r.gradients, [0.1, 0.1, 0.1]);
  assert.ok(r.originalNorms[0] < 1);
  assert.ok(r.clippedNorms[0] < 1);
});

test("clipGradients scales a long vector down to maxNorm", () => {
  const vec = [3, 4]; // norm = 5
  const r = clipGradients(vec, 1);
  const g = /** @type {number[]} */ (r.gradients);
  const norm = Math.sqrt(g[0] * g[0] + g[1] * g[1]);
  assert.ok(Math.abs(norm - 1) < 1e-9, `norm ${norm} not 1`);
  assert.equal(r.originalNorms[0], 5);
  assert.equal(r.clippedNorms[0], 1);
});

test("clipGradients handles a list of vectors independently", () => {
  const r = clipGradients([[3, 4], [0.1, 0.1]], 1);
  const g = /** @type {number[][]} */ (r.gradients);
  const n0 = Math.sqrt(g[0][0] ** 2 + g[0][1] ** 2);
  const n1 = Math.sqrt(g[1][0] ** 2 + g[1][1] ** 2);
  assert.ok(Math.abs(n0 - 1) < 1e-9);
  assert.ok(n1 < 1);
  assert.equal(r.originalNorms.length, 2);
  assert.equal(r.clippedNorms.length, 2);
});

test("clipGradients coerces bad inputs safely", () => {
  const r = clipGradients("not-an-array", 1);
  assert.deepEqual(r.gradients, []);
  const r2 = clipGradients([Number.NaN, 0], 1);
  const g = /** @type {number[]} */ (r2.gradients);
  // NaN became 0, original norm is 0, so no scaling applied.
  assert.deepEqual(g, [0, 0]);
});

// ---- Privacy budget ----

test("computePrivacyBudget returns zero for zero iterations", () => {
  const b = computePrivacyBudget(0.5, 1e-5, 0);
  assert.equal(b.totalEpsilon, 0);
  assert.equal(b.iterations, 0);
});

test("computePrivacyBudget is monotone in iterations", () => {
  const a = computePrivacyBudget(0.1, 1e-6, 10);
  const b = computePrivacyBudget(0.1, 1e-6, 100);
  assert.ok(b.totalEpsilon >= a.totalEpsilon);
  assert.ok(b.totalDelta >= a.totalDelta);
});

test("computePrivacyBudget never exceeds basic composition", () => {
  const eps = 0.2;
  const n = 50;
  const b = computePrivacyBudget(eps, 1e-5, n);
  // Reported bound should be the min of basic (n*eps) and advanced composition.
  assert.ok(b.totalEpsilon <= n * eps + 1e-9);
});

// ---- DP-SGD ----

test("dpSGDStep returns a vector of the right dimension", () => {
  const grads = [
    [0.1, 0.2, 0.3],
    [-0.1, 0.0, 0.2],
    [0.05, 0.05, 0.05],
  ];
  const step = dpSGDStep(grads, 1, 0); // zero noise: deterministic
  assert.equal(step.dimension, 3);
  assert.equal(step.batchSize, 3);
  assert.equal(step.noisyGradient.length, 3);
  // With zero noise the noisy gradient matches the mean gradient.
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(step.noisyGradient[i] - step.meanGradient[i]) < 1e-12);
  }
});

test("dpSGDStep clips large gradients before averaging", () => {
  const grads = [
    [100, 0], // norm 100 -> clipped to 1
    [0, 100], // norm 100 -> clipped to 1
  ];
  const step = dpSGDStep(grads, 1, 0);
  // Mean of [1, 0] and [0, 1] is [0.5, 0.5].
  assert.ok(Math.abs(step.meanGradient[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(step.meanGradient[1] - 0.5) < 1e-9);
  assert.ok(step.clippedNorms.every((n) => n <= 1 + 1e-9));
});

test("dpSGDStep handles empty input gracefully", () => {
  const step = dpSGDStep([], 1, 1);
  assert.deepEqual(step.noisyGradient, []);
  assert.equal(step.batchSize, 0);
});

test("dpSGDStep noiseStddev equals clipNorm * noiseMultiplier", () => {
  const step = dpSGDStep([[1, 2]], 2, 1.5);
  assert.equal(step.noiseStddev, 3);
});

// ---- Privacy accountant ----

test("getPrivacyAccountant records events and tracks totals", async () => {
  const acc = getPrivacyAccountant("test-a");
  await acc.reset();
  await acc.record(0.1, 1e-6, { tag: "step1" });
  await acc.record(0.2, 1e-6, { tag: "step2" });
  const snap = await acc.snapshot();
  assert.equal(snap.steps, 2);
  assert.ok(Math.abs(snap.totalEpsilon - 0.3) < 1e-9);
  assert.ok(Math.abs(snap.totalDelta - 2e-6) < 1e-12);
  assert.equal(snap.events.length, 2);
});

test("getPrivacyAccountant persists state across instances", async () => {
  const a = getPrivacyAccountant("test-persist");
  await a.reset();
  await a.record(0.5, 0, { n: 1 });
  const b = getPrivacyAccountant("test-persist");
  const snap = await b.snapshot();
  assert.equal(snap.steps, 1);
  assert.ok(Math.abs(snap.totalEpsilon - 0.5) < 1e-9);
});

test("getPrivacyAccountant reset clears the cumulative loss", async () => {
  const acc = getPrivacyAccountant("test-reset");
  await acc.record(0.3, 0);
  await acc.reset();
  const snap = await acc.snapshot();
  assert.equal(snap.steps, 0);
  assert.equal(snap.totalEpsilon, 0);
});

test("listPrivacyAccountants returns every known accountant", async () => {
  getPrivacyAccountant("alpha");
  getPrivacyAccountant("beta");
  await getPrivacyAccountant("alpha").record(0.1, 0);
  await getPrivacyAccountant("beta").record(0.2, 0);
  const list = await listPrivacyAccountants();
  const names = list.map((a) => a.name);
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("beta"));
});

// ---- Query leak analysis ----

test("analyzePrivacyLeak flags unbounded sum queries", () => {
  const data = [10, 20, 30, 40, 1000]; // one outlier
  const r = analyzePrivacyLeak((rows) => rows.reduce((s, v) => s + v, 0), data, {
    maxAllowedSensitivity: 100,
  });
  assert.equal(r.leaks, true);
  assert.equal(r.worstIndex, 4);
  assert.ok(r.sensitivity >= 1000 - 1e-9);
});

test("analyzePrivacyLeak approves bounded count queries", () => {
  const data = new Array(20).fill(1);
  const r = analyzePrivacyLeak((rows) => rows.length, data, { maxAllowedSensitivity: 1 });
  assert.equal(r.leaks, false);
  assert.equal(r.sensitivity, 1);
});

test("analyzePrivacyLeak handles errors in the query function", () => {
  const r = analyzePrivacyLeak(() => {
    throw new Error("bad query");
  }, [1, 2, 3]);
  assert.ok(r.error);
  assert.equal(r.leaks, false);
});

test("analyzePrivacyLeak returns zero sensitivity for empty datasets", () => {
  const r = analyzePrivacyLeak((rows) => rows.length, []);
  assert.equal(r.sensitivity, 0);
  assert.equal(r.leaks, false);
  assert.equal(r.inspected, 0);
});

test("analyzePrivacyLeak requires a function query", () => {
  const r = analyzePrivacyLeak(null, [1, 2, 3]);
  assert.ok(r.error);
});

// ---- Internal sampling sanity checks ----

test("_internals.secureUniform produces values strictly in (0, 1)", () => {
  for (let i = 0; i < 50; i++) {
    const u = _internals.secureUniform();
    assert.ok(u > 0 && u < 1, `u=${u} out of (0,1)`);
  }
});

test("_internals.sampleStandardNormal is finite", () => {
  for (let i = 0; i < 50; i++) {
    const v = _internals.sampleStandardNormal();
    assert.ok(Number.isFinite(v));
  }
});
