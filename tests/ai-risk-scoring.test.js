/**
 * Phase 65.5: AI risk scoring tests (NIST AI RMF).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-ai-risk-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  scoreModel,
  getScore,
  listScores,
  getRmfCoverage,
  RMF_CATEGORIES,
} = await import("../lib/ai-risk-scoring.js");

test.after(() => {
  try { rmSync(TMP_DATA_DIR, { recursive: true, force: true }); } catch (_) {}
});

test("RMF_CATEGORIES includes govern/map/measure/manage", () => {
  assert.deepEqual(RMF_CATEGORIES.sort(), ["govern", "manage", "map", "measure"]);
});

test("scoreModel validates modelId and scores", async () => {
  await assert.rejects(() => scoreModel(null, { scores: {} }), /modelId/);
  await assert.rejects(() => scoreModel("m1", {}), /scores/);
  await assert.rejects(() => scoreModel("m1", { scores: { foo: 3 } }), /must include/);
});

test("scoreModel clamps category values to 1-5", async () => {
  const rec = await scoreModel("clamp-model", {
    scores: { govern: 10, map: -1, measure: 3, manage: 4.8 },
    reviewer: "alice",
  });
  assert.equal(rec.latest.scores.govern, 5);
  assert.equal(rec.latest.scores.map, 1);
  assert.equal(rec.latest.scores.measure, 3);
  assert.equal(rec.latest.scores.manage, 5);
});

test("scoreModel computes overall as a weighted average", async () => {
  const rec = await scoreModel("avg-model", {
    scores: { govern: 2, map: 4, measure: 3, manage: 3 },
  });
  assert.ok(Math.abs(rec.latest.overall - 3) < 1e-9);
});

test("scoreModel supports custom weights", async () => {
  const rec = await scoreModel("weighted-model", {
    scores: { govern: 1, map: 5, measure: 5, manage: 5 },
    weights: { govern: 10, map: 0, measure: 0, manage: 0 },
  });
  assert.equal(rec.latest.overall, 1);
});

test("scoreModel assigns risk level thresholds", async () => {
  const critical = await scoreModel("critical-model", { scores: { govern: 1, map: 1, measure: 1, manage: 1 } });
  assert.equal(critical.latest.level, "critical");
  const minimal = await scoreModel("minimal-model", { scores: { govern: 5, map: 5, measure: 5, manage: 5 } });
  assert.equal(minimal.latest.level, "minimal");
  const moderate = await scoreModel("moderate-model", { scores: { govern: 3, map: 3, measure: 3, manage: 3 } });
  assert.equal(moderate.latest.level, "moderate");
});

test("scoreModel appends history entries across calls", async () => {
  await scoreModel("history-model", { scores: { govern: 2 }, reviewer: "r1" });
  await scoreModel("history-model", { scores: { govern: 3 }, reviewer: "r2" });
  const rec = await getScore("history-model");
  assert.equal(rec.history.length, 2);
  assert.equal(rec.latest.reviewer, "r2");
});

test("listScores filters by level and overall", async () => {
  await scoreModel("high-risk", { scores: { govern: 1, map: 2, measure: 2, manage: 2 } });
  await scoreModel("low-risk", { scores: { govern: 4, map: 4, measure: 4, manage: 4 } });
  const high = await listScores({ level: "high" });
  assert.ok(high.some((r) => r.modelId === "high-risk"));
  assert.ok(!high.some((r) => r.modelId === "low-risk"));
  const below3 = await listScores({ maxOverall: 2.5 });
  assert.ok(below3.some((r) => r.modelId === "high-risk"));
});

test("getRmfCoverage computes per-category coverage and averages", async () => {
  // Add a model that leaves one category unset.
  await scoreModel("partial", {
    scores: { govern: 3, map: 4 },
  });
  const coverage = await getRmfCoverage();
  assert.ok(coverage.totalModels > 0);
  for (const cat of RMF_CATEGORIES) {
    assert.ok(cat in coverage.coverage);
    assert.ok(cat in coverage.averages);
  }
  assert.ok(coverage.distribution);
});

test("getScore returns null for unknown model", async () => {
  assert.equal(await getScore("definitely-not-a-model"), null);
});
