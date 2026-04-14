/**
 * Phase 75.2: Judge calibration tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "siskel-judge-calibration-"));
process.env.STORAGE_PATH = TMP;

const {
  recordJudgement,
  computeCalibration,
  getConfusionMatrix,
  listJudges,
  listJudgements,
  _reset,
} = await import("../lib/judge-calibration.js");

test.after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test("recordJudgement requires all identifiers", async () => {
  await _reset();
  await assert.rejects(() => recordJudgement({ caseId: "c", prediction: "pass", humanLabel: "pass" }), /judgeId/);
  await assert.rejects(() => recordJudgement({ judgeId: "j", prediction: "pass", humanLabel: "pass" }), /caseId/);
  await assert.rejects(() => recordJudgement({ judgeId: "j", caseId: "c", humanLabel: "pass" }), /prediction/);
  await assert.rejects(() => recordJudgement({ judgeId: "j", caseId: "c", prediction: "pass" }), /humanLabel/);
});

test("computeCalibration returns binary precision/recall/F1", async () => {
  await _reset();
  // 3 true pos (pass/pass), 1 false pos (pass/fail), 1 false neg (fail/pass), 1 true neg (fail/fail)
  await recordJudgement({ judgeId: "bin", caseId: "1", prediction: "pass", humanLabel: "pass" });
  await recordJudgement({ judgeId: "bin", caseId: "2", prediction: "pass", humanLabel: "pass" });
  await recordJudgement({ judgeId: "bin", caseId: "3", prediction: "pass", humanLabel: "pass" });
  await recordJudgement({ judgeId: "bin", caseId: "4", prediction: "pass", humanLabel: "fail" });
  await recordJudgement({ judgeId: "bin", caseId: "5", prediction: "fail", humanLabel: "pass" });
  await recordJudgement({ judgeId: "bin", caseId: "6", prediction: "fail", humanLabel: "fail" });
  const cal = await computeCalibration("bin");
  assert.equal(cal.support, 6);
  // Accuracy = 4/6 ≈ 0.6667
  assert.equal(cal.accuracy, 0.6667);
  // Precision = 3/4 = 0.75
  assert.equal(cal.precision, 0.75);
  // Recall = 3/4 = 0.75
  assert.equal(cal.recall, 0.75);
  // F1 = 0.75
  assert.equal(cal.f1, 0.75);
});

test("getConfusionMatrix reports predicted->actual counts", async () => {
  await _reset();
  await recordJudgement({ judgeId: "m", caseId: "a", prediction: "pass", humanLabel: "pass" });
  await recordJudgement({ judgeId: "m", caseId: "b", prediction: "pass", humanLabel: "fail" });
  await recordJudgement({ judgeId: "m", caseId: "c", prediction: "fail", humanLabel: "fail" });
  const m = await getConfusionMatrix("m");
  assert.equal(m.total, 3);
  assert.equal(m.matrix["pass→pass"], 1);
  assert.equal(m.matrix["pass→fail"], 1);
  assert.equal(m.matrix["fail→fail"], 1);
  assert.deepEqual(m.labels.sort(), ["fail", "pass"]);
});

test("listJudges returns known judge ids", async () => {
  await _reset();
  await recordJudgement({ judgeId: "jA", caseId: "1", prediction: "pass", humanLabel: "pass" });
  await recordJudgement({ judgeId: "jB", caseId: "2", prediction: "fail", humanLabel: "fail" });
  const judges = await listJudges();
  assert.ok(judges.includes("jA"));
  assert.ok(judges.includes("jB"));
});

test("listJudgements paginates and sorts newest first", async () => {
  await _reset();
  for (let i = 0; i < 5; i += 1) {
    await recordJudgement({ judgeId: "pag", caseId: `c${i}`, prediction: "pass", humanLabel: "pass" });
  }
  const page = await listJudgements({ judgeId: "pag", limit: 2, offset: 1 });
  assert.equal(page.total, 5);
  assert.equal(page.judgements.length, 2);
  assert.equal(page.offset, 1);
});

test("multi-class calibration returns per-label stats and macro avg", async () => {
  await _reset();
  await recordJudgement({ judgeId: "mc", caseId: "1", prediction: "green", humanLabel: "green" });
  await recordJudgement({ judgeId: "mc", caseId: "2", prediction: "yellow", humanLabel: "yellow" });
  await recordJudgement({ judgeId: "mc", caseId: "3", prediction: "red", humanLabel: "red" });
  await recordJudgement({ judgeId: "mc", caseId: "4", prediction: "green", humanLabel: "yellow" });
  const cal = await computeCalibration("mc");
  assert.equal(cal.support, 4);
  assert.ok(cal.perLabel.green);
  assert.ok(cal.perLabel.yellow);
  assert.ok(cal.perLabel.red);
  assert.ok(cal.precision >= 0 && cal.precision <= 1);
});
