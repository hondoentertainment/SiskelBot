/**
 * Phase 58.2: speculative-decoding unit tests.
 * Uses a temp STORAGE_PATH so we don't touch the real data/ directory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-speculative-"));
process.env.STORAGE_PATH = tempDir;

const {
  registerDraftModel,
  registerTargetModel,
  getDraftModel,
  getTargetModel,
  listRegisteredModels,
  mockDraftModel,
  mockTargetModel,
  speculativeGenerate,
  batchedSpeculativeGenerate,
  computeAcceptanceRate,
  computeSpeedup,
  computeExpectedTokensPerIteration,
  acceptDraftToken,
  verifyDraftTokens,
  recordRun,
  getRunHistory,
  getAggregateStats,
  PRESETS,
  getPreset,
} = await import("../lib/speculative-decoding.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ─── registry ────────────────────────────────────────────────────────────────

test("registerDraftModel stores a named implementation", async () => {
  const fn = async () => [{ token: "x", prob: 0.9 }];
  registerDraftModel("draft-test", fn);
  assert.equal(getDraftModel("draft-test"), fn);
  const listed = listRegisteredModels();
  assert.ok(listed.draft.includes("draft-test"));
});

test("registerTargetModel stores a named implementation", async () => {
  const fn = async () => ({ acceptance: [1], targetProbs: [0.9], fallbackToken: { token: "f", prob: 0.5 } });
  registerTargetModel("target-test", fn);
  assert.equal(getTargetModel("target-test"), fn);
  const listed = listRegisteredModels();
  assert.ok(listed.target.includes("target-test"));
});

test("registerDraftModel rejects bad inputs", () => {
  assert.throws(() => registerDraftModel("", () => {}), /name is required/);
  assert.throws(() => registerDraftModel("x", null), /must be a function/);
});

// ─── mock models ─────────────────────────────────────────────────────────────

test("mockDraftModel returns an array of k tokens with prob", async () => {
  const out = await mockDraftModel("hello world", 5);
  assert.equal(Array.isArray(out), true);
  assert.equal(out.length, 5);
  for (const t of out) {
    assert.equal(typeof t.token, "string");
    assert.equal(typeof t.prob, "number");
    assert.ok(t.prob >= 0 && t.prob <= 1);
  }
});

test("mockTargetModel returns acceptance mask and fallback", async () => {
  const drafts = await mockDraftModel("foo", 4);
  const res = await mockTargetModel("foo", drafts);
  assert.ok(Array.isArray(res.acceptance));
  assert.equal(res.acceptance.length, 4);
  assert.ok(res.fallbackToken && typeof res.fallbackToken.token === "string");
  // after the first 0 in the mask, everything must be 0 (speculative rule)
  let sawZero = false;
  for (const a of res.acceptance) {
    if (sawZero) assert.equal(a, 0);
    if (a === 0) sawZero = true;
  }
});

// ─── speculativeGenerate with mocks ──────────────────────────────────────────

test("speculativeGenerate produces text, tokens, and stats", async () => {
  const r = await speculativeGenerate("hello", { maxTokens: 16, gamma: 4 });
  assert.equal(typeof r.text, "string");
  assert.ok(Array.isArray(r.tokens));
  assert.ok(r.tokens.length > 0);
  assert.ok(r.stats);
  assert.equal(typeof r.stats.accepted, "number");
  assert.equal(typeof r.stats.rejected, "number");
  assert.equal(typeof r.stats.iterations, "number");
  assert.ok("speedupEstimate" in r.stats);
  assert.equal(r.stats.gamma, 4);
});

test("speculativeGenerate accepted + rejected counts are non-negative and at least one iteration", async () => {
  const r = await speculativeGenerate("something", { maxTokens: 8, gamma: 3 });
  assert.ok(r.stats.accepted >= 0);
  assert.ok(r.stats.rejected >= 0);
  assert.ok(r.stats.iterations >= 1);
});

test("speculativeGenerate honors maxTokens upper bound", async () => {
  const r = await speculativeGenerate("abc", { maxTokens: 5, gamma: 4 });
  assert.ok(r.tokens.length <= 5);
});

test("speculativeGenerate halts on stop tokens", async () => {
  // Force a stop token by injecting a draft model that always emits "STOP"
  const stopDraft = async () => [{ token: "STOP", prob: 0.9 }];
  const okTarget = async () => ({
    acceptance: [1],
    targetProbs: [0.95],
    fallbackToken: { token: "x", prob: 0.5 },
  });
  registerDraftModel("stop-draft", stopDraft);
  registerTargetModel("ok-target", okTarget);
  const r = await speculativeGenerate("anything", {
    draftModel: "stop-draft",
    targetModel: "ok-target",
    maxTokens: 20,
    gamma: 1,
    stopTokens: ["STOP"],
  });
  assert.equal(r.stats.stopReason, "stop_token");
  assert.equal(r.tokens[r.tokens.length - 1], "STOP");
});

// ─── statistics math ─────────────────────────────────────────────────────────

test("computeAcceptanceRate basics", () => {
  assert.equal(computeAcceptanceRate({ accepted: 0, rejected: 0 }), 0);
  assert.equal(computeAcceptanceRate({ accepted: 3, rejected: 1 }), 0.75);
  assert.equal(computeAcceptanceRate({ accepted: 5, rejected: 0 }), 1);
  assert.equal(computeAcceptanceRate(null), 0);
});

test("computeExpectedTokensPerIteration formula", () => {
  // α = 0, γ = 4  -> 1 token per iteration (the fallback)
  assert.equal(computeExpectedTokensPerIteration(0, 4), 1);
  // α = 1, γ = 4  -> γ + 1 = 5
  assert.equal(computeExpectedTokensPerIteration(1, 4), 5);
  // α = 0.5, γ = 2  -> (1 - 0.5^3) / 0.5 = (1 - 0.125) / 0.5 = 1.75
  const v = computeExpectedTokensPerIteration(0.5, 2);
  assert.ok(Math.abs(v - 1.75) < 1e-9);
});

test("computeSpeedup math favors high acceptance", () => {
  const lowStats = { accepted: 1, rejected: 9, gamma: 4 };
  const highStats = { accepted: 9, rejected: 1, gamma: 4 };
  const low = computeSpeedup(lowStats, 100, 10);
  const high = computeSpeedup(highStats, 100, 10);
  assert.ok(high > low);
  // degenerate: zero target latency -> zero speedup
  assert.equal(computeSpeedup(highStats, 0, 0), 0);
});

// ─── batched ─────────────────────────────────────────────────────────────────

test("batchedSpeculativeGenerate runs over each prompt", async () => {
  const out = await batchedSpeculativeGenerate(["a", "b", "c"], { maxTokens: 6, gamma: 2 });
  assert.equal(out.runs.length, 3);
  for (const r of out.runs) {
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.tokens));
  }
  assert.equal(out.aggregate.successes, 3);
  assert.equal(out.aggregate.failures, 0);
  assert.ok(typeof out.aggregate.acceptanceRate === "number");
});

// ─── persistence ─────────────────────────────────────────────────────────────

test("recordRun persists and getRunHistory returns it", async () => {
  const rec = await recordRun({
    workspaceId: "ws-hist",
    draftModel: "mock",
    targetModel: "mock",
    tokens: 20,
    accepted: 15,
    rejected: 5,
    iterations: 8,
    gamma: 4,
    acceptanceRate: 0.75,
    speedupEstimate: 2.1,
    durationMs: 42,
    stopReason: "max_tokens",
  });
  assert.ok(rec.id);
  const list = await getRunHistory({ workspaceId: "ws-hist" });
  assert.ok(list.some((r) => r.id === rec.id));
});

test("getRunHistory filters by draft model", async () => {
  await recordRun({ workspaceId: "ws-filter", draftModel: "alpha", targetModel: "mock", tokens: 1 });
  await recordRun({ workspaceId: "ws-filter", draftModel: "beta", targetModel: "mock", tokens: 1 });
  const filt = await getRunHistory({ workspaceId: "ws-filter", draftModel: "alpha" });
  assert.ok(filt.length >= 1);
  for (const r of filt) assert.equal(r.draftModel, "alpha");
});

test("getAggregateStats sums totals across runs", async () => {
  const ws = "ws-agg-" + Date.now();
  await recordRun({ workspaceId: ws, draftModel: "mock", targetModel: "mock", tokens: 10, accepted: 7, rejected: 3, iterations: 4, gamma: 4, speedupEstimate: 2 });
  await recordRun({ workspaceId: ws, draftModel: "mock", targetModel: "mock", tokens: 20, accepted: 18, rejected: 2, iterations: 6, gamma: 4, speedupEstimate: 3 });
  const agg = await getAggregateStats({ workspaceId: ws });
  assert.equal(agg.totals.runs, 2);
  assert.equal(agg.totals.tokens, 30);
  assert.equal(agg.totals.accepted, 25);
  assert.equal(agg.totals.rejected, 5);
  assert.equal(agg.acceptanceRate, 25 / 30);
  assert.equal(agg.avgSpeedup, 2.5);
  assert.equal(agg.byDraftModel.mock, 2);
});

// ─── token-level verification ────────────────────────────────────────────────

test("acceptDraftToken deterministic with seeded rng", () => {
  // target 0.9, draft 0.5 -> ratio = 1, always accept
  const rng = () => 0.99;
  assert.equal(acceptDraftToken(0.5, 0.9, rng), true);
  // target 0.1, draft 0.9 -> ratio ≈ 0.111; r=0.5 rejects
  assert.equal(acceptDraftToken(0.9, 0.1, () => 0.5), false);
  // same ratio, r below threshold accepts
  assert.equal(acceptDraftToken(0.9, 0.1, () => 0.01), true);
});

test("verifyDraftTokens stops at first rejection", () => {
  const drafts = [
    { token: "a", prob: 0.5 },
    { token: "b", prob: 0.9 },
    { token: "c", prob: 0.5 },
  ];
  // target probs all 0.9 except second 0.01 -> reject at index 1
  const targetProbs = [0.9, 0.01, 0.9];
  const rng = () => 0.5;
  const out = verifyDraftTokens(drafts, targetProbs, rng);
  assert.equal(out.accepted.length, 1);
  assert.equal(out.accepted[0].token, "a");
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].token, "b");
  assert.equal(out.position, 1);
});

test("verifyDraftTokens accepts all when target >= draft", () => {
  const drafts = [
    { token: "a", prob: 0.3 },
    { token: "b", prob: 0.4 },
    { token: "c", prob: 0.5 },
  ];
  const targetProbs = [0.9, 0.9, 0.9];
  const out = verifyDraftTokens(drafts, targetProbs, () => 0.999);
  assert.equal(out.accepted.length, 3);
  assert.equal(out.rejected.length, 0);
  assert.equal(out.position, 3);
});

// ─── presets ─────────────────────────────────────────────────────────────────

test("PRESETS exposed with expected shape", () => {
  assert.ok(PRESETS.conservative && PRESETS.balanced && PRESETS.aggressive);
  assert.equal(PRESETS.conservative.gamma, 2);
  assert.equal(PRESETS.balanced.gamma, 4);
  assert.equal(PRESETS.aggressive.gamma, 8);
  for (const p of Object.values(PRESETS)) {
    assert.ok(typeof p.acceptanceMinimum === "number");
  }
});

test("getPreset returns preset by name or null", () => {
  assert.equal(getPreset("balanced").gamma, 4);
  assert.equal(getPreset("unknown"), null);
});

// ─── maxTokens / stopTokens edge cases ───────────────────────────────────────

test("maxTokens honored across multiple draft rounds", async () => {
  const r = await speculativeGenerate("multi-round", { maxTokens: 3, gamma: 2 });
  assert.ok(r.tokens.length <= 3);
});

test("stopTokens halt mid-draft on fallback token", async () => {
  // draft always emits REJ which will be rejected, and target fallback is STOP.
  const rejDraft = async () => [{ token: "REJ", prob: 0.9 }];
  const stopTarget = async () => ({
    acceptance: [0],
    targetProbs: [0.01],
    fallbackToken: { token: "STOP", prob: 0.5 },
  });
  registerDraftModel("rej-draft", rejDraft);
  registerTargetModel("stop-fb-target", stopTarget);
  const r = await speculativeGenerate("x", {
    draftModel: "rej-draft",
    targetModel: "stop-fb-target",
    maxTokens: 20,
    gamma: 1,
    stopTokens: ["STOP"],
  });
  assert.equal(r.stats.stopReason, "stop_token");
  assert.equal(r.tokens[r.tokens.length - 1], "STOP");
});
