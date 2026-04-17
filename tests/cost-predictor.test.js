/**
 * Unit tests for lib/cost-predictor.js — cost prediction for agent runs.
 *
 * Covers: recordRunCost + predictCost roundtrip, heuristic fallback with
 * < 5 records, p50/p90 correctness for known data, confidence scaling,
 * workspace isolation, record cap enforcement, and edge cases.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { recordRunCost, predictCost, __resetPredictorForTests } = await import(
  "../lib/cost-predictor.js"
);
const { parseCostConfig } = await import("../lib/smart-router.js");

test.afterEach(() => {
  __resetPredictorForTests();
  parseCostConfig("");
});

test.after(() => {
  __resetPredictorForTests();
  parseCostConfig("");
});

// ── Heuristic fallback (< 5 records) ──────────────────────────────────────

test("predictCost falls back to heuristic when no history exists", () => {
  parseCostConfig("gpt-4:0.06");

  const result = predictCost({
    workspace: "ws1",
    model: "gpt-4",
    goalLength: 200,
  });

  // heuristic: 200/100 * 0.06 * 15 = 1.8
  assert.equal(result.basedOnRuns, 0);
  assert.equal(result.confidence, 0);
  assert.ok(Math.abs(result.estimatedUsd - 1.8) < 1e-9, `estimatedUsd=${result.estimatedUsd}`);
  assert.ok(Math.abs(result.p50Usd - 1.8) < 1e-9);
  assert.ok(Math.abs(result.p90Usd - 1.8) < 1e-9);
});

test("heuristic uses goalLength=100 when goalLength not provided", () => {
  parseCostConfig("m1:0.01");

  const result = predictCost({ workspace: "ws1", model: "m1" });

  // 100/100 * 0.01 * 15 = 0.15
  assert.ok(Math.abs(result.estimatedUsd - 0.15) < 1e-9);
});

test("heuristic returns 0 when model cost is 0 (unknown model)", () => {
  parseCostConfig(""); // no model costs

  const result = predictCost({
    workspace: "ws1",
    model: "unknown-model",
    goalLength: 500,
  });

  assert.equal(result.estimatedUsd, 0);
  assert.equal(result.basedOnRuns, 0);
});

test("heuristic fallback with 1-4 records still uses heuristic", () => {
  parseCostConfig("m2:0.02");

  for (let i = 0; i < 4; i++) {
    recordRunCost({
      workspace: "ws1",
      model: "m2",
      costUsd: 0.5 + i * 0.1,
      iterations: 10,
      tokens: 1000,
    });
  }

  const result = predictCost({ workspace: "ws1", model: "m2", goalLength: 200 });
  assert.equal(result.basedOnRuns, 4);
  // Still heuristic: 200/100 * 0.02 * 15 = 0.6
  assert.ok(Math.abs(result.estimatedUsd - 0.6) < 1e-9);
  assert.equal(result.confidence, 4 / 20);
});

// ── Data-driven prediction (>= 5 records) ─────────────────────────────────

test("recordRunCost + predictCost roundtrip with 5 records uses data", () => {
  const costs = [0.10, 0.20, 0.30, 0.40, 0.50];
  for (const costUsd of costs) {
    recordRunCost({
      workspace: "ws2",
      model: "gpt-3.5",
      costUsd,
      iterations: 5,
      tokens: 500,
    });
  }

  const result = predictCost({ workspace: "ws2", model: "gpt-3.5" });
  assert.equal(result.basedOnRuns, 5);
  // p50 of [0.10, 0.20, 0.30, 0.40, 0.50] = 0.30
  assert.ok(Math.abs(result.p50Usd - 0.30) < 1e-9, `p50Usd=${result.p50Usd}`);
  assert.equal(result.estimatedUsd, result.p50Usd);
});

test("p50 and p90 are correct for known data", () => {
  // 10 records with costs 0.1 through 1.0
  for (let i = 1; i <= 10; i++) {
    recordRunCost({
      workspace: "stats-ws",
      model: "m3",
      costUsd: i * 0.1,
      iterations: i,
      tokens: i * 100,
    });
  }

  const result = predictCost({ workspace: "stats-ws", model: "m3" });
  assert.equal(result.basedOnRuns, 10);

  // sorted: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
  // p50: index = 0.5 * 9 = 4.5 → lerp(0.5, 0.6) = 0.55
  assert.ok(Math.abs(result.p50Usd - 0.55) < 1e-9, `p50Usd=${result.p50Usd}`);

  // p90: index = 0.9 * 9 = 8.1 → lerp(0.9, 1.0, 0.1) = 0.91
  assert.ok(Math.abs(result.p90Usd - 0.91) < 1e-9, `p90Usd=${result.p90Usd}`);
});

// ── Confidence scaling ─────────────────────────────────────────────────────

test("confidence scales from 0 to 1.0 based on record count", () => {
  for (let i = 0; i < 25; i++) {
    recordRunCost({
      workspace: "conf-ws",
      model: "m4",
      costUsd: 0.1,
      iterations: 1,
      tokens: 100,
    });

    const result = predictCost({ workspace: "conf-ws", model: "m4" });
    const expected = Math.min((i + 1) / 20, 1.0);
    assert.ok(
      Math.abs(result.confidence - expected) < 1e-9,
      `records=${i + 1}, confidence=${result.confidence}, expected=${expected}`
    );
  }
});

test("confidence caps at 1.0 for 20+ records", () => {
  for (let i = 0; i < 30; i++) {
    recordRunCost({ workspace: "cap-ws", model: "m5", costUsd: 0.5, iterations: 5, tokens: 500 });
  }

  const result = predictCost({ workspace: "cap-ws", model: "m5" });
  assert.equal(result.confidence, 1.0);
  assert.equal(result.basedOnRuns, 30);
});

// ── Profile filtering ──────────────────────────────────────────────────────

test("predictCost filters by profile when provided", () => {
  for (let i = 0; i < 10; i++) {
    recordRunCost({ workspace: "prof-ws", profile: "researcher", model: "m6", costUsd: 0.1, iterations: 5, tokens: 500 });
    recordRunCost({ workspace: "prof-ws", profile: "executor", model: "m6", costUsd: 0.9, iterations: 20, tokens: 2000 });
  }

  const researcherResult = predictCost({ workspace: "prof-ws", profile: "researcher", model: "m6" });
  const executorResult = predictCost({ workspace: "prof-ws", profile: "executor", model: "m6" });

  assert.equal(researcherResult.basedOnRuns, 10);
  assert.equal(executorResult.basedOnRuns, 10);
  assert.ok(researcherResult.p50Usd < executorResult.p50Usd);
});

test("predictCost without profile matches all profiles for the model", () => {
  for (let i = 0; i < 5; i++) {
    recordRunCost({ workspace: "all-ws", profile: "researcher", model: "m7", costUsd: 0.1, iterations: 5, tokens: 500 });
    recordRunCost({ workspace: "all-ws", profile: "executor", model: "m7", costUsd: 0.5, iterations: 15, tokens: 1500 });
  }

  const result = predictCost({ workspace: "all-ws", model: "m7" });
  assert.equal(result.basedOnRuns, 10);
});

// ── Workspace isolation ────────────────────────────────────────────────────

test("workspaces are isolated from each other", () => {
  for (let i = 0; i < 10; i++) {
    recordRunCost({ workspace: "iso-a", model: "m8", costUsd: 0.1, iterations: 1, tokens: 100 });
  }

  const resultA = predictCost({ workspace: "iso-a", model: "m8" });
  const resultB = predictCost({ workspace: "iso-b", model: "m8" });

  assert.equal(resultA.basedOnRuns, 10);
  assert.equal(resultB.basedOnRuns, 0);
});

// ── Record cap enforcement ─────────────────────────────────────────────────

test("history is capped at 2000 records per workspace", () => {
  for (let i = 0; i < 2100; i++) {
    recordRunCost({
      workspace: "cap-test",
      model: "m9",
      costUsd: i * 0.001,
      iterations: 1,
      tokens: 10,
    });
  }

  // After adding 2100, should retain the latest 2000.
  const result = predictCost({ workspace: "cap-test", model: "m9" });
  assert.equal(result.basedOnRuns, 2000);
});

// ── __resetPredictorForTests ───────────────────────────────────────────────

test("__resetPredictorForTests clears all history", () => {
  recordRunCost({ workspace: "reset-ws", model: "m10", costUsd: 1.0, iterations: 1, tokens: 100 });
  __resetPredictorForTests();

  const result = predictCost({ workspace: "reset-ws", model: "m10" });
  assert.equal(result.basedOnRuns, 0);
});

// ── Response shape ─────────────────────────────────────────────────────────

test("predictCost returns all required fields", () => {
  const result = predictCost({ workspace: "shape-ws", model: "any" });
  assert.ok("estimatedUsd" in result);
  assert.ok("confidence" in result);
  assert.ok("basedOnRuns" in result);
  assert.ok("p50Usd" in result);
  assert.ok("p90Usd" in result);
  assert.equal(typeof result.estimatedUsd, "number");
  assert.equal(typeof result.confidence, "number");
  assert.equal(typeof result.basedOnRuns, "number");
  assert.equal(typeof result.p50Usd, "number");
  assert.equal(typeof result.p90Usd, "number");
});
