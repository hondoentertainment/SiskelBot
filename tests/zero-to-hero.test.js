/**
 * Tests for lib/zero-to-hero.js and lib/karpathy-exercises.js.
 * Covers curriculum structure, progress tracking, prerequisite gating,
 * badge awarding, sandboxed exercise grading, and the leaderboard.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";

// Isolate storage to a tmp dir for this test suite.
const tmpRoot = mkdtempSync(join(tmpdir(), "zth-test-"));
process.env.STORAGE_PATH = tmpRoot;

const {
  CURRICULUM,
  BADGES,
  startCurriculum,
  getUserProgress,
  completeLesson,
  submitExercise,
  getNextLesson,
  getLessonContent,
  getLeaderboard,
  awardBadge,
  getUserBadges,
} = await import("../lib/zero-to-hero.js");
const { runExercise } = await import("../lib/karpathy-exercises.js");

test.after(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// --- Curriculum structure ---

test("curriculum has the expected 9 lessons in order", () => {
  assert.equal(CURRICULUM.lessons.length, 9);
  for (let i = 0; i < CURRICULUM.lessons.length; i++) {
    assert.equal(CURRICULUM.lessons[i].order, i + 1);
  }
  const ids = CURRICULUM.lessons.map((l) => l.id);
  assert.ok(ids.includes("micrograd"));
  assert.ok(ids.includes("nano-gpt"));
  assert.ok(ids.includes("tokenizer"));
  assert.ok(ids.includes("reproducing-gpt2"));
});

test("every lesson has required metadata fields", () => {
  for (const lesson of CURRICULUM.lessons) {
    assert.ok(typeof lesson.id === "string" && lesson.id.length > 0);
    assert.ok(typeof lesson.title === "string" && lesson.title.length > 0);
    assert.ok(typeof lesson.description === "string");
    assert.ok(Array.isArray(lesson.prerequisites));
    assert.ok(typeof lesson.estimatedHours === "number");
  }
});

test("lesson prerequisites chain correctly", () => {
  // Micrograd has none
  const mg = CURRICULUM.lessons.find((l) => l.id === "micrograd");
  assert.deepEqual(mg.prerequisites, []);
  // makemore-bigram depends on micrograd
  const bg = CURRICULUM.lessons.find((l) => l.id === "makemore-bigram");
  assert.ok(bg.prerequisites.includes("micrograd"));
});

test("BADGES dictionary contains all six badges", () => {
  for (const id of [
    "first_steps",
    "backprop_master",
    "language_modeler",
    "gpt_builder",
    "tokenizer_wizard",
    "zero_to_hero",
  ]) {
    assert.ok(BADGES[id], `missing badge: ${id}`);
    assert.equal(BADGES[id].id, id);
  }
});

// --- Progress tracking ---

test("startCurriculum initializes progress for a new user", async () => {
  const uid = "test-user-start-" + Date.now();
  const result = await startCurriculum(uid, "default");
  assert.equal(result.started, true);
  assert.equal(result.userId, uid);
  assert.equal(result.currentLessonId, "micrograd");
  assert.deepEqual(result.completedLessons, []);
});

test("getUserProgress returns a default shape for new users", async () => {
  const uid = "test-user-new-" + Date.now();
  const p = await getUserProgress(uid);
  assert.equal(p.userId, uid);
  assert.equal(p.completedCount, 0);
  assert.equal(p.totalLessons, CURRICULUM.lessons.length);
  assert.equal(p.percentComplete, 0);
  assert.equal(p.currentLesson, "micrograd");
});

test("getNextLesson returns micrograd for a new user", async () => {
  const uid = "test-user-next-" + Date.now();
  const lesson = await getNextLesson(uid);
  assert.equal(lesson.id, "micrograd");
});

// --- Lesson unlocking and completion ---

test("completeLesson marks lesson complete and unlocks next", async () => {
  const uid = "test-user-complete-" + Date.now();
  await startCurriculum(uid, "default");
  const r = await completeLesson(uid, "micrograd", {});
  assert.equal(r.completed, true);
  assert.equal(r.lessonId, "micrograd");
  assert.equal(r.nextLessonId, "makemore-bigram");
  const p = await getUserProgress(uid);
  assert.ok(p.completedLessons.includes("micrograd"));
  assert.equal(p.currentLesson, "makemore-bigram");
});

test("completeLesson rejects lessons whose prerequisites are unmet", async () => {
  const uid = "test-user-prereq-" + Date.now();
  await startCurriculum(uid, "default");
  await assert.rejects(() => completeLesson(uid, "nano-gpt", {}), /Prerequisites not met/);
});

test("completeLesson rejects unknown lessons", async () => {
  const uid = "test-user-unknown-" + Date.now();
  await assert.rejects(() => completeLesson(uid, "not-a-lesson", {}), /Unknown lesson/);
});

test("completing micrograd awards first_steps and backprop_master badges", async () => {
  const uid = "test-user-badges-" + Date.now();
  await startCurriculum(uid, "default");
  const r = await completeLesson(uid, "micrograd", {});
  assert.ok(r.awardedBadges.includes("first_steps"));
  assert.ok(r.awardedBadges.includes("backprop_master"));
  const { badges } = await getUserBadges(uid);
  const ids = badges.map((b) => b.id);
  assert.ok(ids.includes("first_steps"));
  assert.ok(ids.includes("backprop_master"));
});

test("completing all makemore lessons awards language_modeler", async () => {
  const uid = "test-user-mm-" + Date.now();
  await startCurriculum(uid, "default");
  const chain = [
    "micrograd",
    "makemore-bigram",
    "makemore-mlp",
    "makemore-activations",
    "makemore-backprop",
    "makemore-wavenet",
  ];
  let last;
  for (const id of chain) last = await completeLesson(uid, id, {});
  assert.ok(last.awardedBadges.includes("language_modeler"));
});

test("completing the whole curriculum awards zero_to_hero", async () => {
  const uid = "test-user-zth-" + Date.now();
  await startCurriculum(uid, "default");
  for (const lesson of CURRICULUM.lessons) {
    await completeLesson(uid, lesson.id, {});
  }
  const { badges } = await getUserBadges(uid);
  const ids = badges.map((b) => b.id);
  assert.ok(ids.includes("zero_to_hero"));
  assert.ok(ids.includes("gpt_builder"));
  assert.ok(ids.includes("tokenizer_wizard"));
});

test("awardBadge is idempotent and rejects unknown badges", async () => {
  const uid = "test-user-badge-idem-" + Date.now();
  await awardBadge(uid, "first_steps");
  await awardBadge(uid, "first_steps");
  const { badges } = await getUserBadges(uid);
  assert.equal(badges.filter((b) => b.id === "first_steps").length, 1);
  await assert.rejects(() => awardBadge(uid, "nonsense"), /Unknown badge/);
});

// --- Lesson content ---

test("getLessonContent returns exercises with starter code", async () => {
  const lesson = await getLessonContent("micrograd");
  assert.ok(lesson);
  assert.ok(Array.isArray(lesson.exercises));
  assert.ok(lesson.exercises.length > 0);
  const valueEx = lesson.exercises.find((e) => e.id === "value-class");
  assert.ok(valueEx);
  assert.ok(typeof valueEx.starterCode === "string");
  assert.match(valueEx.starterCode, /class Value/);
});

test("getLessonContent returns null for unknown lessons", async () => {
  const lesson = await getLessonContent("does-not-exist");
  assert.equal(lesson, null);
});

// --- Exercise sandbox grading ---

test("runExercise grades a correct manualBackprop solution as passing", () => {
  const code = `
function manualBackprop(a, b, c) {
  return { f: (a + b) * c, dfa: c, dfb: c, dfc: a + b };
}
globalThis.manualBackprop = manualBackprop;
`;
  const r = runExercise("manual-backprop", code);
  assert.equal(r.passed, true);
  assert.equal(r.score, 100);
});

test("runExercise grades an incorrect solution as failing", () => {
  const code = `
function manualBackprop(a, b, c) { return { f: 0, dfa: 0, dfb: 0, dfc: 0 }; }
globalThis.manualBackprop = manualBackprop;
`;
  const r = runExercise("manual-backprop", code);
  assert.equal(r.passed, false);
  assert.ok(r.score < 100);
});

test("runExercise handles the full micrograd Value class", () => {
  const code = `
class Value {
  constructor(data, children = []) {
    this.data = data;
    this.grad = 0;
    this._prev = children;
    this._backward = () => {};
  }
  add(other) {
    const out = new Value(this.data + other.data, [this, other]);
    const self = this;
    out._backward = () => {
      self.grad += out.grad;
      other.grad += out.grad;
    };
    return out;
  }
  mul(other) {
    const out = new Value(this.data * other.data, [this, other]);
    const self = this;
    out._backward = () => {
      self.grad += other.data * out.grad;
      other.grad += self.data * out.grad;
    };
    return out;
  }
  backward() {
    const topo = [];
    const visited = new Set();
    const build = (v) => {
      if (visited.has(v)) return;
      visited.add(v);
      for (const child of v._prev) build(child);
      topo.push(v);
    };
    build(this);
    this.grad = 1;
    for (let i = topo.length - 1; i >= 0; i--) topo[i]._backward();
  }
}
globalThis.Value = Value;
`;
  const r = runExercise("value-class", code);
  assert.equal(r.passed, true, `Expected all tests to pass, got: ${JSON.stringify(r)}`);
});

test("runExercise rejects dangerous constructs like require()", () => {
  const code = "const fs = require('fs'); globalThis.manualBackprop = () => {};";
  const r = runExercise("manual-backprop", code);
  assert.equal(r.passed, false);
  assert.match(r.feedback, /Disallowed construct/);
});

test("runExercise rejects empty code", () => {
  const r = runExercise("manual-backprop", "");
  assert.equal(r.passed, false);
  assert.match(r.feedback, /Empty solution/);
});

test("runExercise reports unknown exercise id", () => {
  const r = runExercise("not-a-real-exercise", "globalThis.foo = 1;");
  assert.equal(r.passed, false);
  assert.match(r.feedback, /Unknown exercise/);
});

test("runExercise catches infinite loops via vm timeout", () => {
  const code = "while (true) {} globalThis.manualBackprop = () => {};";
  const r = runExercise("manual-backprop", code);
  assert.equal(r.passed, false);
  // vm reports either a timeout or script execution error
  assert.ok(r.errors.length > 0);
});

test("runExercise grades softmax correctly", () => {
  const code = `
function softmaxRow(row) {
  const m = Math.max(...row);
  const exps = row.map((v) => Math.exp(v - m));
  const s = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / s);
}
globalThis.softmaxRow = softmaxRow;
`;
  const r = runExercise("self-attention", code);
  assert.equal(r.passed, true);
});

test("runExercise grades mostFrequentPair correctly", () => {
  const code = `
function mostFrequentPair(tokens) {
  if (!tokens || tokens.length < 2) return null;
  const counts = new Map();
  for (let i = 0; i < tokens.length - 1; i++) {
    const k = tokens[i] + ',' + tokens[i+1];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [k, v] of counts) {
    if (v > bestCount) { bestCount = v; best = k; }
  }
  return best.split(',').map(Number);
}
globalThis.mostFrequentPair = mostFrequentPair;
`;
  const r = runExercise("bpe-encoder", code);
  assert.equal(r.passed, true);
});

// --- submitExercise integration ---

test("submitExercise persists results to progress", async () => {
  const uid = "test-user-submit-" + Date.now();
  const code = `
function manualBackprop(a, b, c) {
  return { f: (a + b) * c, dfa: c, dfb: c, dfc: a + b };
}
globalThis.manualBackprop = manualBackprop;
`;
  const r = await submitExercise(uid, "manual-backprop", code);
  assert.equal(r.passed, true);
  assert.equal(r.score, 100);
});

test("submitExercise records failure without throwing", async () => {
  const uid = "test-user-fail-" + Date.now();
  const r = await submitExercise(uid, "manual-backprop", "globalThis.manualBackprop = () => ({ f: 0, dfa: 0, dfb: 0, dfc: 0 });");
  assert.equal(r.passed, false);
});

// --- Leaderboard ---

test("leaderboard ranks users by completed lessons", async () => {
  const ws = "test-ws-" + Date.now();
  const uid1 = "lb-user-1-" + Date.now();
  const uid2 = "lb-user-2-" + Date.now();
  await startCurriculum(uid1, ws);
  await startCurriculum(uid2, ws);
  await completeLesson(uid1, "micrograd", {});
  await completeLesson(uid2, "micrograd", {});
  await completeLesson(uid2, "makemore-bigram", {});
  const board = await getLeaderboard(ws);
  assert.ok(board.entries.length >= 2);
  // uid2 completed more lessons, should rank higher (lower rank number)
  const r1 = board.entries.find((e) => e.userId === uid1);
  const r2 = board.entries.find((e) => e.userId === uid2);
  assert.ok(r2.rank < r1.rank, `expected uid2(${r2.rank}) to rank above uid1(${r1.rank})`);
});

test("leaderboard is empty for a workspace with no participants", async () => {
  const board = await getLeaderboard("empty-ws-" + Date.now());
  assert.deepEqual(board.entries, []);
});
