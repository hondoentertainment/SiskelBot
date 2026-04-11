/**
 * Phase 56.4: Curriculum scheduler tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-curriculum-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;

const {
  createCurriculum,
  nextTask,
  recordResult,
  getSkillLevel,
  adjustDifficulty,
  listCurricula,
} = await import("../lib/curriculum-scheduler.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

function sampleTasks() {
  return [
    { id: "t1", prompt: "easy 1", difficulty: 1 },
    { id: "t2", prompt: "easy 2", difficulty: 2 },
    { id: "t3", prompt: "mid 1", difficulty: 3 },
    { id: "t4", prompt: "hard 1", difficulty: 4 },
    { id: "t5", prompt: "hard 2", difficulty: 5 },
  ];
}

/* -------------------------------------------------------------------------- */

test("createCurriculum persists tasks and clamps difficulties", async () => {
  const cur = await createCurriculum({
    name: "main",
    tasks: [
      { id: "lo", difficulty: -5 },
      { id: "hi", difficulty: 99 },
      { id: "mid", difficulty: 3 },
    ],
    initialSkill: 2,
  });
  assert.ok(cur.id.startsWith("cur_"));
  assert.equal(cur.tasks[0].difficulty, 1);
  assert.equal(cur.tasks[1].difficulty, 5);
  assert.equal(cur.tasks[2].difficulty, 3);
  assert.equal(cur.initialSkill, 2);
});

test("createCurriculum rejects invalid input", async () => {
  await assert.rejects(() => createCurriculum(null), /required/);
  await assert.rejects(() => createCurriculum({ tasks: [] }), /tasks array required/);
});

test("listCurricula returns created curricula", async () => {
  const list = await listCurricula();
  assert.ok(list.length >= 1);
  assert.ok(list.every((c) => typeof c.id === "string"));
});

test("nextTask picks a task within the agent's difficulty band", async () => {
  const cur = await createCurriculum({ tasks: sampleTasks(), initialSkill: 2, bandWidth: 1 });
  const t = await nextTask(cur.id, "agentA");
  assert.ok(t);
  // Should be near difficulty 2 (1.5-2.5)
  assert.ok(t.difficulty >= 1 && t.difficulty <= 3);
});

test("getSkillLevel returns initial skill for new agents", async () => {
  const cur = await createCurriculum({ tasks: sampleTasks(), initialSkill: 3 });
  const skill = await getSkillLevel(cur.id, "agentB");
  assert.equal(skill.skill, 3);
  assert.deepEqual(skill.history, []);
});

test("recordResult raises skill on success and lowers on failure", async () => {
  const cur = await createCurriculum({ tasks: sampleTasks(), initialSkill: 3 });
  const before = await getSkillLevel(cur.id, "learner");
  assert.equal(before.skill, 3);
  // Succeed on a hard task (diff 5) -> big raise
  const r1 = await recordResult(cur.id, "learner", { taskId: "t5", correct: true });
  assert.ok(r1.skill > 3);
  // Fail easy task -> drop
  const r2 = await recordResult(cur.id, "learner", { taskId: "t1", correct: false });
  assert.ok(r2.skill < r1.skill);
});

test("recordResult rejects unknown tasks", async () => {
  const cur = await createCurriculum({ tasks: sampleTasks() });
  await assert.rejects(() => recordResult(cur.id, "x", { taskId: "nope", correct: true }), /not in curriculum/);
  await assert.rejects(() => recordResult(cur.id, "x", null), /result.taskId/);
});

test("adjustDifficulty shifts initial skill and optionally agent skills", async () => {
  const cur = await createCurriculum({ tasks: sampleTasks(), initialSkill: 3 });
  await recordResult(cur.id, "zed", { taskId: "t3", correct: true });
  const before = await getSkillLevel(cur.id, "zed");
  const adj = await adjustDifficulty(cur.id, 1, { applyToAgents: true });
  assert.ok(adj.initialSkill > 3);
  const after = await getSkillLevel(cur.id, "zed");
  assert.ok(after.skill > before.skill);
});

test("adjustDifficulty clamps to 1..5", async () => {
  const cur = await createCurriculum({ tasks: sampleTasks(), initialSkill: 3 });
  const down = await adjustDifficulty(cur.id, -1000);
  assert.equal(down.initialSkill, 1);
  const up = await adjustDifficulty(cur.id, 1000);
  assert.equal(up.initialSkill, 5);
});

test("nextTask avoids repeating tasks until pool exhausted", async () => {
  const cur = await createCurriculum({
    name: "small",
    tasks: [
      { id: "a", difficulty: 3 },
      { id: "b", difficulty: 3 },
      { id: "c", difficulty: 3 },
    ],
    initialSkill: 3,
    bandWidth: 2,
  });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const t = await nextTask(cur.id, "walker");
    if (t) ids.push(t.id);
  }
  assert.deepEqual(ids.sort(), ["a", "b", "c"]);
  // 4th call allows repeats
  const repeat = await nextTask(cur.id, "walker");
  assert.ok(repeat);
});

test("skill band shifts after successful run", async () => {
  const cur = await createCurriculum({ tasks: sampleTasks(), initialSkill: 2, bandWidth: 1 });
  for (let i = 0; i < 5; i++) {
    const t = await nextTask(cur.id, "rocket");
    if (!t) break;
    await recordResult(cur.id, "rocket", { taskId: t.id, correct: true });
  }
  const s = await getSkillLevel(cur.id, "rocket");
  assert.ok(s.skill > 2);
  assert.ok(s.band.hi > 2);
});
