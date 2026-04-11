/**
 * Phase 65.5: AI risk scoring tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-risk-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  scoreSystem,
  listDimensions,
  getRiskReport,
  recordAssessment,
  listAssessments,
} = await import("../lib/ai-risk-scoring.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

test("listDimensions returns all four NIST RMF dimensions", () => {
  const dims = listDimensions();
  const keys = dims.map((d) => d.key).sort();
  assert.deepEqual(keys, ["govern", "manage", "map", "measure"]);
  for (const d of dims) {
    assert.ok(Array.isArray(d.questions));
    assert.ok(d.questions.length > 0);
    for (const q of d.questions) {
      assert.ok(q.id);
      assert.ok(q.text);
      assert.ok(Number.isFinite(q.weight));
    }
  }
});

test("scoreSystem yields 100 for a fully compliant system", () => {
  const dims = listDimensions();
  const answers = {};
  for (const d of dims) {
    answers[d.key] = {};
    for (const q of d.questions) answers[d.key][q.id] = 5;
  }
  const result = scoreSystem({ name: "fully-compliant", answers });
  assert.equal(result.overall, 100);
  assert.equal(result.level, "low");
  assert.equal(result.recommendations.length, 0);
});

test("scoreSystem yields 0 for an empty assessment", () => {
  const result = scoreSystem({ name: "empty", answers: {} });
  assert.equal(result.overall, 0);
  assert.equal(result.level, "critical");
  assert.ok(result.recommendations.length > 0);
});

test("scoreSystem clamps out-of-range answers", () => {
  const dims = listDimensions();
  const answers = {};
  for (const d of dims) {
    answers[d.key] = {};
    for (const q of d.questions) answers[d.key][q.id] = 999;
  }
  const result = scoreSystem({ name: "clamped", answers });
  assert.equal(result.overall, 100);
});

test("scoreSystem requires a name", () => {
  assert.throws(() => scoreSystem({ answers: {} }));
  assert.throws(() => scoreSystem(null));
});

test("scoreSystem returns recommendations for low-scoring questions", () => {
  const result = scoreSystem({
    name: "partial",
    answers: {
      govern: { gov_policy: 1, gov_accountability: 4, gov_oversight: 4, gov_training: 5 },
    },
  });
  assert.ok(result.recommendations.some((r) => r.includes("Govern")));
});

test("recordAssessment persists and scoreSystem output is included", async () => {
  const rec = await recordAssessment({
    name: "siskel-prod",
    version: "1.0",
    owner: "ml-team",
    answers: {
      govern: { gov_policy: 5, gov_accountability: 5, gov_oversight: 4, gov_training: 3 },
      map: { map_use_case: 4, map_stakeholders: 4, map_risks: 4, map_dependencies: 3 },
      measure: { meas_evals: 5, meas_fairness: 3, meas_monitoring: 4, meas_redteam: 2 },
      manage: { man_incident: 5, man_rollback: 5, man_comms: 4, man_review: 4 },
    },
    notes: "quarterly review",
  });
  assert.ok(rec.id);
  assert.equal(rec.systemName, "siskel-prod");
  assert.ok(rec.overall > 0);
  assert.ok(["low", "medium", "high", "critical"].includes(rec.level));
});

test("listAssessments filters by system and level", async () => {
  await recordAssessment({ name: "alpha", answers: {} });
  await recordAssessment({ name: "alpha", answers: {} });
  const alpha = await listAssessments({ systemName: "alpha" });
  assert.ok(alpha.length >= 2);
  for (const a of alpha) assert.equal(a.systemName, "alpha");
  const crit = await listAssessments({ level: "critical" });
  for (const a of crit) assert.equal(a.level, "critical");
});

test("getRiskReport returns latest and trend", async () => {
  // First assessment: mostly zeros
  await recordAssessment({
    name: "trend-sys",
    answers: {
      govern: { gov_policy: 1 },
    },
  });
  // Second: improved
  await recordAssessment({
    name: "trend-sys",
    answers: {
      govern: { gov_policy: 5, gov_accountability: 5, gov_oversight: 5, gov_training: 5 },
      map: { map_use_case: 5, map_stakeholders: 5, map_risks: 5, map_dependencies: 5 },
      measure: { meas_evals: 5, meas_fairness: 5, meas_monitoring: 5, meas_redteam: 5 },
      manage: { man_incident: 5, man_rollback: 5, man_comms: 5, man_review: 5 },
    },
  });
  const rpt = await getRiskReport("trend-sys");
  assert.ok(rpt.latest);
  assert.equal(rpt.history.length, 2);
  assert.equal(rpt.trend, "improving");
});

test("getRiskReport returns empty history for unknown system", async () => {
  const rpt = await getRiskReport("nothing-here");
  assert.equal(rpt.latest, null);
  assert.deepEqual(rpt.history, []);
  assert.equal(rpt.trend, "flat");
  await assert.rejects(() => getRiskReport(""));
});
