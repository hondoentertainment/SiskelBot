/**
 * Phase 75.1: Eval-in-prod (shadow traffic) tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-eval-in-prod-"));
process.env.STORAGE_PATH = TMP;

const {
  recordShadowSample,
  querySamples,
  getShadowStats,
  setShadowConfig,
  getShadowConfig,
  computeDiff,
  _reset,
} = await import("../lib/eval-in-prod.js");

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("computeDiff returns token/jaccard stats", () => {
  const diff = computeDiff("hello world", "hello there");
  assert.equal(diff.tokensProd, 2);
  assert.equal(diff.tokensCandidate, 2);
  assert.equal(diff.sharedTokens, 1);
  assert.equal(diff.uniqueProd, 1);
  assert.equal(diff.uniqueCandidate, 1);
  assert.ok(diff.jaccard > 0 && diff.jaccard < 1);
  assert.equal(diff.identical, false);

  const same = computeDiff("abc def", "abc def");
  assert.equal(same.identical, true);
  assert.equal(same.jaccard, 1);
});

test("recordShadowSample stores and querySamples returns it", async () => {
  await _reset();
  const s = await recordShadowSample({
    workspaceId: "ws-a",
    request: { prompt: "hi" },
    prodResponse: "hello from prod",
    candidateResponse: "hello from candidate",
    candidateModel: "llm-v2",
  });
  assert.ok(s.sampleId);
  assert.equal(s.candidateModel, "llm-v2");
  assert.ok(s.diff);
  const q = await querySamples({ workspaceId: "ws-a" });
  assert.equal(q.total, 1);
  assert.equal(q.samples[0].sampleId, s.sampleId);
});

test("querySamples filters by candidateModel", async () => {
  await _reset();
  await recordShadowSample({ workspaceId: "ws", prodResponse: "a", candidateResponse: "b", candidateModel: "m1" });
  await recordShadowSample({ workspaceId: "ws", prodResponse: "a", candidateResponse: "c", candidateModel: "m2" });
  await recordShadowSample({ workspaceId: "ws", prodResponse: "a", candidateResponse: "d", candidateModel: "m1" });
  const m1 = await querySamples({ workspaceId: "ws", candidateModel: "m1" });
  assert.equal(m1.total, 2);
  const m2 = await querySamples({ workspaceId: "ws", candidateModel: "m2" });
  assert.equal(m2.total, 1);
});

test("getShadowStats aggregates jaccard and identical counts", async () => {
  await _reset();
  await recordShadowSample({ workspaceId: "ws2", prodResponse: "foo bar", candidateResponse: "foo bar", candidateModel: "m" });
  await recordShadowSample({ workspaceId: "ws2", prodResponse: "foo bar", candidateResponse: "totally different", candidateModel: "m" });
  const stats = await getShadowStats({ workspaceId: "ws2" });
  assert.equal(stats.total, 2);
  assert.equal(stats.identical, 1);
  assert.equal(stats.identicalRatio, 0.5);
  assert.ok(stats.avgJaccard >= 0 && stats.avgJaccard <= 1);
  assert.equal(stats.byCandidateModel.m, 2);
});

test("setShadowConfig / getShadowConfig round-trips", async () => {
  await _reset();
  const cfg = await setShadowConfig({ workspaceId: "cfg-ws", enabled: true, candidateModel: "mx", sampleRate: 0.25 });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.candidateModel, "mx");
  assert.equal(cfg.sampleRate, 0.25);
  const got = await getShadowConfig("cfg-ws");
  assert.equal(got.enabled, true);
  assert.equal(got.candidateModel, "mx");
  assert.equal(got.sampleRate, 0.25);
});

test("querySamples supports pagination", async () => {
  await _reset();
  for (let i = 0; i < 7; i += 1) {
    await recordShadowSample({ workspaceId: "pag", prodResponse: `p${i}`, candidateResponse: `c${i}`, candidateModel: "m" });
  }
  const page = await querySamples({ workspaceId: "pag", limit: 3, offset: 2 });
  assert.equal(page.total, 7);
  assert.equal(page.samples.length, 3);
  assert.equal(page.offset, 2);
});

test("EVAL_IN_PROD_MAX_SAMPLES trims old entries", async () => {
  await _reset();
  process.env.EVAL_IN_PROD_MAX_SAMPLES = "3";
  for (let i = 0; i < 6; i += 1) {
    await recordShadowSample({ workspaceId: "trim", prodResponse: "p", candidateResponse: "c", candidateModel: "m" });
  }
  delete process.env.EVAL_IN_PROD_MAX_SAMPLES;
  const q = await querySamples({ workspaceId: "trim" });
  assert.equal(q.total, 3);
});
