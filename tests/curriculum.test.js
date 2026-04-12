/**
 * Phase 56.4: curriculum scheduler unit tests.
 * Uses a temp STORAGE_PATH so tests don't touch data/.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = mkdtempSync(join(tmpdir(), "siskelbot-curriculum-"));
process.env.STORAGE_PATH = tempDir;

const {
  SkillEstimator,
  CurriculumScheduler,
  createCurriculum,
  getCurriculum,
  listCurricula,
  deleteCurriculum,
  recordCurriculumStep,
  getCurriculumHistory,
  linearProgression,
  adaptiveProgression,
  spiralProgression,
  detectPlateau,
  recommendNextTask,
  generateProgressReport,
} = await import("../lib/curriculum.js");

test.after(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ─── SkillEstimator ─────────────────────────────────────────────────────────

test("SkillEstimator: update on success raises skill", () => {
  const est = new SkillEstimator({ alpha: 0.2, initialSkill: 0.4 });
  const before = est.getSkill();
  est.update(0.5, true);
  assert.ok(est.getSkill() > before, "success should raise skill");
});

test("SkillEstimator: update on failure lowers skill", () => {
  const est = new SkillEstimator({ alpha: 0.2, initialSkill: 0.6 });
  const before = est.getSkill();
  est.update(0.5, false);
  assert.ok(est.getSkill() < before, "failure should lower skill");
});

test("SkillEstimator: Elo-style update magnitude is alpha * (actual - expected)", () => {
  const est = new SkillEstimator({ alpha: 0.1, initialSkill: 0.5 });
  const d = 0.5;
  const expected = est.expectedSuccessRate(d);
  // At equal skill/difficulty, expected is ~0.5. Success with alpha=0.1 -> delta=0.05.
  assert.ok(Math.abs(expected - 0.5) < 1e-9);
  const prev = est.getSkill();
  const { delta } = est.update(d, true);
  assert.ok(Math.abs(delta - 0.05) < 1e-6, `delta should be ~0.05, got ${delta}`);
  assert.ok(Math.abs(est.getSkill() - (prev + 0.05)) < 1e-6);
});

test("SkillEstimator: expectedSuccessRate monotonic in skill", () => {
  const difficulty = 0.5;
  const lo = new SkillEstimator({ initialSkill: 0.2 });
  const mid = new SkillEstimator({ initialSkill: 0.5 });
  const hi = new SkillEstimator({ initialSkill: 0.8 });
  const a = lo.expectedSuccessRate(difficulty);
  const b = mid.expectedSuccessRate(difficulty);
  const c = hi.expectedSuccessRate(difficulty);
  assert.ok(a < b, `expected a < b, got ${a} !< ${b}`);
  assert.ok(b < c, `expected b < c, got ${b} !< ${c}`);
});

test("SkillEstimator: clamps to [min, max]", () => {
  const est = new SkillEstimator({ alpha: 1, initialSkill: 0.95, minSkill: 0, maxSkill: 1 });
  // A huge positive push shouldn't exceed max.
  for (let i = 0; i < 100; i += 1) est.update(0, true);
  assert.ok(est.getSkill() <= 1);
  const est2 = new SkillEstimator({ alpha: 1, initialSkill: 0.05 });
  for (let i = 0; i < 100; i += 1) est2.update(1, false);
  assert.ok(est2.getSkill() >= 0);
});

test("SkillEstimator: toJSON / fromJSON roundtrip", () => {
  const est = new SkillEstimator({ alpha: 0.15, initialSkill: 0.42, minSkill: 0, maxSkill: 1 });
  est.update(0.5, true);
  est.update(0.6, false);
  const json = est.toJSON();
  const restored = SkillEstimator.fromJSON(json);
  assert.equal(restored.alpha, est.alpha);
  assert.equal(restored.getSkill(), est.getSkill());
  assert.equal(restored.samples, est.samples);
});

// ─── CurriculumScheduler ────────────────────────────────────────────────────

test("CurriculumScheduler: nextDifficulty near target expected rate", () => {
  const sched = new CurriculumScheduler({
    targetSuccessRate: 0.7,
    skillEstimator: new SkillEstimator({ initialSkill: 0.5 }),
  });
  const d = sched.nextDifficulty();
  const expected = sched.skillEstimator.expectedSuccessRate(d);
  assert.ok(Math.abs(expected - 0.7) < 0.1, `expected ~0.7, got ${expected}`);
});

test("CurriculumScheduler: recordOutcome updates skill and pushes history", () => {
  const sched = new CurriculumScheduler({
    skillEstimator: new SkillEstimator({ alpha: 0.2, initialSkill: 0.4 }),
  });
  const before = sched.skillEstimator.getSkill();
  const step = sched.recordOutcome(0.5, true, { taskId: "t1", durationMs: 123 });
  assert.equal(step.taskId, "t1");
  assert.equal(step.durationMs, 123);
  assert.equal(step.success, true);
  assert.equal(sched.history.length, 1);
  assert.ok(sched.skillEstimator.getSkill() > before);
});

test("CurriculumScheduler: getProgress returns summary", () => {
  const sched = new CurriculumScheduler({
    skillEstimator: new SkillEstimator({ alpha: 0.1, initialSkill: 0.3 }),
  });
  sched.recordOutcome(0.3, true);
  sched.recordOutcome(0.4, true);
  sched.recordOutcome(0.5, false);
  const p = sched.getProgress();
  assert.equal(p.samples, 3);
  assert.ok(p.history.length === 3);
  assert.ok(p.avgDifficulty > 0);
  assert.ok(p.recentSuccessRate >= 0 && p.recentSuccessRate <= 1);
  assert.equal(typeof p.trend, "number");
});

// ─── Persistence ────────────────────────────────────────────────────────────

test("createCurriculum persists a curriculum record", async () => {
  const name = "curr-create-" + Date.now();
  const rec = await createCurriculum(name, { targetSuccessRate: 0.65 });
  assert.equal(rec.name, name);
  assert.equal(rec.targetSuccessRate, 0.65);
  assert.ok(Array.isArray(rec.history));
  assert.ok(rec.skillEstimator);
  const loaded = await getCurriculum(name);
  assert.equal(loaded.name, name);
});

test("createCurriculum rejects duplicate name", async () => {
  const name = "curr-dup-" + Date.now();
  await createCurriculum(name);
  await assert.rejects(() => createCurriculum(name), /already exists/);
});

test("listCurricula returns all non-deleted curricula", async () => {
  const a = "curr-list-a-" + Date.now();
  const b = "curr-list-b-" + Date.now();
  await createCurriculum(a);
  await createCurriculum(b);
  const all = await listCurricula();
  const names = all.map((c) => c.name);
  assert.ok(names.includes(a));
  assert.ok(names.includes(b));
});

test("deleteCurriculum removes a curriculum", async () => {
  const name = "curr-del-" + Date.now();
  await createCurriculum(name);
  const res = await deleteCurriculum(name);
  assert.equal(res.ok, true);
  const after = await getCurriculum(name);
  assert.equal(after, null);
  const bad = await deleteCurriculum(name);
  assert.equal(bad.ok, false);
});

test("recordCurriculumStep persists step and updates skill", async () => {
  const name = "curr-step-" + Date.now();
  await createCurriculum(name, {
    skillEstimator: { alpha: 0.2, initialSkill: 0.3 },
  });
  const before = await getCurriculum(name);
  const beforeSkill = before.skillEstimator.skill;
  const result = await recordCurriculumStep(name, {
    taskId: "task-1",
    difficulty: 0.4,
    success: true,
    durationMs: 500,
  });
  assert.equal(result.step.taskId, "task-1");
  assert.equal(result.step.success, true);
  assert.ok(result.record.skillEstimator.skill > beforeSkill);
  const after = await getCurriculum(name);
  assert.equal(after.history.length, 1);
});

test("recordCurriculumStep rejects missing difficulty", async () => {
  const name = "curr-step-bad-" + Date.now();
  await createCurriculum(name);
  await assert.rejects(
    () => recordCurriculumStep(name, { success: true }),
    /difficulty must be a number/,
  );
});

test("recordCurriculumStep rejects unknown curriculum", async () => {
  await assert.rejects(
    () => recordCurriculumStep("does-not-exist-xyz", { difficulty: 0.5, success: true }),
    /not found/,
  );
});

test("getCurriculumHistory returns step records", async () => {
  const name = "curr-hist-" + Date.now();
  await createCurriculum(name);
  await recordCurriculumStep(name, { difficulty: 0.3, success: true });
  await recordCurriculumStep(name, { difficulty: 0.4, success: false });
  const hist = await getCurriculumHistory(name);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].success, true);
  assert.equal(hist[1].success, false);
});

// ─── Strategies ─────────────────────────────────────────────────────────────

test("linearProgression returns evenly spaced sequence", () => {
  const seq = linearProgression(0.2, 0.8, 4);
  assert.equal(seq.length, 4);
  assert.ok(Math.abs(seq[0] - 0.2) < 1e-9);
  assert.ok(Math.abs(seq[3] - 0.8) < 1e-9);
  // Increments are equal.
  const d1 = seq[1] - seq[0];
  const d2 = seq[2] - seq[1];
  assert.ok(Math.abs(d1 - d2) < 1e-9);
});

test("adaptiveProgression adjusts with skill", () => {
  const low = adaptiveProgression(0.2, 0.7);
  const high = adaptiveProgression(0.8, 0.7);
  assert.ok(high > low, `skill up should raise recommended difficulty (${low} vs ${high})`);
});

test("spiralProgression cycles through phases", () => {
  const out = spiralProgression([
    [0.2, 0.3],
    [0.25, 0.35],
    [0.3, 0.4],
  ]);
  // Visits phase0[0], phase1[0], phase2[0], phase0[1], phase1[1], phase2[1]
  assert.deepEqual(out, [0.2, 0.25, 0.3, 0.3, 0.35, 0.4]);
});

// ─── Plateau detection ──────────────────────────────────────────────────────

test("detectPlateau on flat history returns plateaued=true with suggestion", () => {
  const history = [];
  for (let i = 0; i < 12; i += 1) {
    history.push({ difficulty: 0.5, success: true, skillAfter: 0.7 });
  }
  const result = detectPlateau(history, 10);
  assert.equal(result.plateaued, true);
  assert.ok(result.suggestion && typeof result.suggestion === "string");
});

test("detectPlateau on learning history returns plateaued=false", () => {
  const history = [];
  for (let i = 0; i < 12; i += 1) {
    history.push({ difficulty: 0.5, success: i % 2 === 0, skillAfter: 0.3 + i * 0.03 });
  }
  const result = detectPlateau(history, 10);
  assert.equal(result.plateaued, false);
});

test("detectPlateau insufficient data", () => {
  const result = detectPlateau([{ skillAfter: 0.5, success: true }], 10);
  assert.equal(result.plateaued, false);
  assert.equal(result.reason, "insufficient_data");
});

test("detectPlateau suggests raising difficulty when success is very high", () => {
  const history = [];
  for (let i = 0; i < 12; i += 1) {
    history.push({ difficulty: 0.3, success: true, skillAfter: 0.85 });
  }
  const r = detectPlateau(history, 10);
  assert.equal(r.plateaued, true);
  assert.match(r.suggestion, /raise|increase/i);
});

// ─── Recommendations ────────────────────────────────────────────────────────

test("recommendNextTask picks task closest to target difficulty", () => {
  const sched = new CurriculumScheduler({
    targetSuccessRate: 0.7,
    skillEstimator: new SkillEstimator({ initialSkill: 0.5 }),
  });
  const target = sched.nextDifficulty();
  const tasks = [
    { id: "a", difficulty: target - 0.3 },
    { id: "b", difficulty: target + 0.05 },
    { id: "c", difficulty: target + 0.5 },
  ];
  const rec = recommendNextTask(tasks, sched);
  assert.equal(rec.task.id, "b");
  assert.ok(rec.delta < 0.2);
});

test("recommendNextTask returns null for empty pool", () => {
  const sched = new CurriculumScheduler();
  const r = recommendNextTask([], sched);
  assert.equal(r, null);
});

// ─── Reports ────────────────────────────────────────────────────────────────

test("generateProgressReport returns expected structure", async () => {
  const name = "curr-report-" + Date.now();
  await createCurriculum(name);
  await recordCurriculumStep(name, { difficulty: 0.3, success: true });
  await recordCurriculumStep(name, { difficulty: 0.4, success: true });
  await recordCurriculumStep(name, { difficulty: 0.5, success: false });
  const report = await generateProgressReport(name);
  assert.equal(report.name, name);
  assert.equal(report.samples, 3);
  assert.equal(typeof report.currentSkill, "number");
  assert.equal(typeof report.overallSuccessRate, "number");
  assert.equal(typeof report.nextDifficulty, "number");
  assert.ok(report.plateau);
});

test("generateProgressReport returns null for missing curriculum", async () => {
  const r = await generateProgressReport("missing-curr-xyz-abc");
  assert.equal(r, null);
});

// ─── Scheduler toJSON/fromJSON roundtrip ────────────────────────────────────

test("CurriculumScheduler toJSON/fromJSON roundtrip preserves state", () => {
  const sched = new CurriculumScheduler({
    targetSuccessRate: 0.65,
    skillEstimator: new SkillEstimator({ alpha: 0.15, initialSkill: 0.5 }),
  });
  sched.recordOutcome(0.4, true);
  sched.recordOutcome(0.5, false);
  const json = sched.toJSON();
  const restored = CurriculumScheduler.fromJSON(json);
  assert.equal(restored.targetSuccessRate, sched.targetSuccessRate);
  assert.equal(restored.skillEstimator.getSkill(), sched.skillEstimator.getSkill());
  assert.equal(restored.history.length, sched.history.length);
});
