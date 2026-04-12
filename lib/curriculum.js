/**
 * Phase 56.4: Curriculum scheduler.
 *
 * Progressive task difficulty based on agent skill. Uses an Elo-style
 * skill estimator to track an agent's ability, and selects the next task
 * difficulty so that expected success rate matches a target rate (e.g. 0.7).
 *
 * Storage layout (via json-path-store):
 *   data/curricula/{name}.json            — curriculum record (skill, history, options)
 *   data/curricula/_index.json            — index of curriculum names
 */
import { join } from "path";
import { readJsonPath, writeJsonPath, withPathLock, getDataDir } from "./json-path-store.js";

// ─── path helpers ───────────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "default";
}

function curriculumPath(name) {
  return join(getDataDir(), "curricula", `${sanitize(name)}.json`);
}

function indexPath() {
  return join(getDataDir(), "curricula", "_index.json");
}

// ─── Skill estimator ────────────────────────────────────────────────────────

/**
 * Elo-style skill estimator. Skill and difficulty share a numeric scale
 * (defaulting to 0..1). Expected success rate is sigmoid(skill - difficulty).
 */
export class SkillEstimator {
  constructor(options = {}) {
    this.alpha = typeof options.alpha === "number" ? options.alpha : 0.1;
    this.minSkill = typeof options.minSkill === "number" ? options.minSkill : 0;
    this.maxSkill = typeof options.maxSkill === "number" ? options.maxSkill : 1;
    const initial = typeof options.initialSkill === "number" ? options.initialSkill : 0.3;
    this.skill = this._clamp(initial);
    this.samples = 0;
  }

  _clamp(value) {
    if (!Number.isFinite(value)) return this.minSkill;
    return Math.max(this.minSkill, Math.min(this.maxSkill, value));
  }

  /**
   * Expected success rate for a given task difficulty, using a logistic
   * function over the skill-minus-difficulty gap.
   */
  expectedSuccessRate(difficulty) {
    const d = typeof difficulty === "number" ? difficulty : 0.5;
    // Scale gap by a factor so the sigmoid is meaningful on 0..1 ranges.
    const scale = 6;
    const gap = (this.skill - d) * scale;
    return 1 / (1 + Math.exp(-gap));
  }

  /**
   * Update skill using an Elo-style rule.
   *   skill += alpha * (actual - expected)
   * Success = 1, failure = 0. If the agent succeeds against a hard task the
   * update is larger than against an easy one.
   */
  update(taskDifficulty, success) {
    const actual = success ? 1 : 0;
    const expected = this.expectedSuccessRate(taskDifficulty);
    const delta = this.alpha * (actual - expected);
    this.skill = this._clamp(this.skill + delta);
    this.samples += 1;
    return { skill: this.skill, delta, expected };
  }

  getSkill() {
    return this.skill;
  }

  toJSON() {
    return {
      alpha: this.alpha,
      minSkill: this.minSkill,
      maxSkill: this.maxSkill,
      skill: this.skill,
      samples: this.samples,
    };
  }

  static fromJSON(json) {
    const est = new SkillEstimator({
      alpha: json?.alpha,
      minSkill: json?.minSkill,
      maxSkill: json?.maxSkill,
      initialSkill: json?.skill,
    });
    est.samples = typeof json?.samples === "number" ? json.samples : 0;
    return est;
  }
}

// ─── Curriculum scheduler ───────────────────────────────────────────────────

export class CurriculumScheduler {
  constructor(options = {}) {
    this.targetSuccessRate =
      typeof options.targetSuccessRate === "number" ? options.targetSuccessRate : 0.7;
    this.difficultyStepSize =
      typeof options.difficultyStepSize === "number" ? options.difficultyStepSize : 0.05;
    this.minDifficulty =
      typeof options.minDifficulty === "number" ? options.minDifficulty : 0;
    this.maxDifficulty =
      typeof options.maxDifficulty === "number" ? options.maxDifficulty : 1;
    this.skillEstimator =
      options.skillEstimator instanceof SkillEstimator
        ? options.skillEstimator
        : new SkillEstimator(options.skillEstimator || {});
    this.history = Array.isArray(options.history) ? options.history.slice() : [];
  }

  /**
   * Pick a task difficulty where expected success rate is closest to target.
   * For a logistic model, invert: gap = ln(t / (1 - t)) / scale, then
   * difficulty = skill - gap.
   */
  nextDifficulty() {
    const t = Math.max(0.01, Math.min(0.99, this.targetSuccessRate));
    const scale = 6;
    const gap = Math.log(t / (1 - t)) / scale;
    const raw = this.skillEstimator.getSkill() - gap;
    // Quantise to the configured step size for stable suggestions.
    const step = Math.max(0.001, this.difficultyStepSize);
    const snapped = Math.round(raw / step) * step;
    return Math.max(this.minDifficulty, Math.min(this.maxDifficulty, snapped));
  }

  recordOutcome(taskDifficulty, success, extras = {}) {
    const update = this.skillEstimator.update(taskDifficulty, Boolean(success));
    const step = {
      at: extras.at || new Date().toISOString(),
      difficulty: Number(taskDifficulty),
      success: Boolean(success),
      skillAfter: update.skill,
      expectedBefore: update.expected,
      ...(extras.taskId ? { taskId: String(extras.taskId) } : {}),
      ...(typeof extras.durationMs === "number" ? { durationMs: extras.durationMs } : {}),
    };
    this.history.push(step);
    return step;
  }

  getProgress() {
    const n = this.history.length;
    const windowSize = Math.min(10, n);
    const recent = this.history.slice(-windowSize);
    const successes = recent.filter((s) => s.success).length;
    const recentSuccessRate = recent.length ? successes / recent.length : 0;
    const difficulties = this.history.map((s) => s.difficulty);
    const avgDifficulty =
      difficulties.length
        ? difficulties.reduce((a, b) => a + b, 0) / difficulties.length
        : 0;
    const firstSkill =
      this.history.length > 0 ? this.history[0].skillAfter : this.skillEstimator.getSkill();
    const trend = this.skillEstimator.getSkill() - firstSkill;
    return {
      currentSkill: this.skillEstimator.getSkill(),
      samples: this.history.length,
      recentSuccessRate,
      avgDifficulty,
      trend,
      history: this.history.slice(),
    };
  }

  toJSON() {
    return {
      targetSuccessRate: this.targetSuccessRate,
      difficultyStepSize: this.difficultyStepSize,
      minDifficulty: this.minDifficulty,
      maxDifficulty: this.maxDifficulty,
      skillEstimator: this.skillEstimator.toJSON(),
      history: this.history.slice(),
    };
  }

  static fromJSON(json) {
    const est = SkillEstimator.fromJSON(json?.skillEstimator || {});
    return new CurriculumScheduler({
      targetSuccessRate: json?.targetSuccessRate,
      difficultyStepSize: json?.difficultyStepSize,
      minDifficulty: json?.minDifficulty,
      maxDifficulty: json?.maxDifficulty,
      skillEstimator: est,
      history: Array.isArray(json?.history) ? json.history : [],
    });
  }
}

// ─── Persistence ────────────────────────────────────────────────────────────

async function updateIndex(name, remove = false) {
  await withPathLock(indexPath(), async () => {
    const idx = await readJsonPath(indexPath(), { names: [] });
    const list = Array.isArray(idx.names) ? idx.names : [];
    const filtered = list.filter((n) => n !== name);
    if (!remove) filtered.push(name);
    await writeJsonPath(indexPath(), { names: filtered });
  });
}

export async function createCurriculum(name, options = {}) {
  const safe = sanitize(name);
  if (!safe || safe === "default" && !name) {
    throw new Error("curriculum name is required");
  }
  const existing = await readJsonPath(curriculumPath(name), null);
  if (existing && existing.name && !existing._deleted) {
    const err = new Error(`curriculum ${name} already exists`);
    err.code = "ALREADY_EXISTS";
    throw err;
  }
  const scheduler = new CurriculumScheduler(options);
  const record = {
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...scheduler.toJSON(),
  };
  await writeJsonPath(curriculumPath(name), record);
  await updateIndex(name, false);
  return record;
}

export async function getCurriculum(name) {
  const data = await readJsonPath(curriculumPath(name), null);
  if (!data || !data.name || data._deleted) return null;
  return data;
}

export async function listCurricula() {
  const idx = await readJsonPath(indexPath(), { names: [] });
  const names = Array.isArray(idx.names) ? idx.names : [];
  const records = [];
  for (const n of names) {
    const rec = await getCurriculum(n);
    if (rec) records.push(rec);
  }
  return records;
}

export async function deleteCurriculum(name) {
  const existing = await readJsonPath(curriculumPath(name), null);
  if (!existing || !existing.name) return { ok: false, code: "NOT_FOUND" };
  await writeJsonPath(curriculumPath(name), { _deleted: true });
  await updateIndex(name, true);
  return { ok: true };
}

/**
 * Record a step against a persisted curriculum. Loads, updates skill, saves.
 * step = { taskId, difficulty, success, durationMs }
 */
export async function recordCurriculumStep(curriculumName, step) {
  if (!step || typeof step !== "object") {
    throw new Error("step is required");
  }
  if (typeof step.difficulty !== "number") {
    throw new Error("step.difficulty must be a number");
  }
  return withPathLock(curriculumPath(curriculumName), async () => {
    const rec = await readJsonPath(curriculumPath(curriculumName), null);
    if (!rec || !rec.name || rec._deleted) {
      const err = new Error(`curriculum ${curriculumName} not found`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const scheduler = CurriculumScheduler.fromJSON(rec);
    const recorded = scheduler.recordOutcome(step.difficulty, Boolean(step.success), {
      taskId: step.taskId,
      durationMs: step.durationMs,
    });
    const updated = {
      ...rec,
      ...scheduler.toJSON(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonPath(curriculumPath(curriculumName), updated);
    return { step: recorded, record: updated };
  });
}

export async function getCurriculumHistory(curriculumName) {
  const rec = await getCurriculum(curriculumName);
  if (!rec) return null;
  return Array.isArray(rec.history) ? rec.history : [];
}

// ─── Progression strategies ─────────────────────────────────────────────────

/**
 * Return a fixed sequence of difficulties from start to end in `steps` steps.
 */
export function linearProgression(startDifficulty, endDifficulty, steps) {
  const n = Math.max(1, Math.floor(steps));
  if (n === 1) return [startDifficulty];
  const out = [];
  const delta = (endDifficulty - startDifficulty) / (n - 1);
  for (let i = 0; i < n; i += 1) {
    out.push(startDifficulty + delta * i);
  }
  return out;
}

/**
 * Pick the next difficulty adaptively from an agent's current skill so that
 * the expected success rate is near `targetRate`.
 */
export function adaptiveProgression(skill, targetRate = 0.7) {
  const est = new SkillEstimator({ initialSkill: skill });
  const sched = new CurriculumScheduler({
    targetSuccessRate: targetRate,
    skillEstimator: est,
  });
  return sched.nextDifficulty();
}

/**
 * Spiral progression: cycle through multiple `phases`, each an array of
 * difficulties. Returns one flat sequence that visits each phase once, then
 * repeats the phase cycle at an elevated difficulty. Phases typically
 * represent topics or skill dimensions.
 *
 * Input: [ [0.2,0.3], [0.25,0.35], [0.3,0.4] ]
 * Output interleaves: phase0[0], phase1[0], phase2[0], phase0[1], phase1[1], ...
 */
export function spiralProgression(phases) {
  if (!Array.isArray(phases) || phases.length === 0) return [];
  const maxLen = Math.max(...phases.map((p) => (Array.isArray(p) ? p.length : 0)));
  const out = [];
  for (let i = 0; i < maxLen; i += 1) {
    for (const phase of phases) {
      if (Array.isArray(phase) && i < phase.length) {
        out.push(phase[i]);
      }
    }
  }
  return out;
}

// ─── Plateau detection ──────────────────────────────────────────────────────

/**
 * Detect whether recent history is plateaued — skill has stopped improving
 * or success rate is stuck. Returns { plateaued, reason, suggestion }.
 */
export function detectPlateau(history, windowSize = 10) {
  const list = Array.isArray(history) ? history : [];
  if (list.length < windowSize) {
    return {
      plateaued: false,
      reason: "insufficient_data",
      suggestion: `need at least ${windowSize} samples, have ${list.length}`,
    };
  }
  const window = list.slice(-windowSize);
  const skills = window.map((s) => (typeof s.skillAfter === "number" ? s.skillAfter : 0));
  const successRate = window.filter((s) => s.success).length / window.length;
  const first = skills[0];
  const last = skills[skills.length - 1];
  const skillDelta = last - first;
  const mean = skills.reduce((a, b) => a + b, 0) / skills.length;
  const variance =
    skills.reduce((a, b) => a + (b - mean) * (b - mean), 0) / skills.length;

  // Plateau: variance low AND absolute skill change small.
  const lowVariance = variance < 0.0005;
  const smallDelta = Math.abs(skillDelta) < 0.02;
  if (lowVariance && smallDelta) {
    let suggestion = "increase task difficulty or diversify topics";
    if (successRate >= 0.9) {
      suggestion = "skill is high; raise difficulty to keep learning";
    } else if (successRate <= 0.2) {
      suggestion = "agent is stuck; lower difficulty or change approach";
    }
    return {
      plateaued: true,
      reason: "low_variance",
      suggestion,
      successRate,
      variance,
      skillDelta,
    };
  }
  return {
    plateaued: false,
    reason: "learning",
    suggestion: "continue current progression",
    successRate,
    variance,
    skillDelta,
  };
}

// ─── Recommendations ────────────────────────────────────────────────────────

/**
 * From a pool of candidate tasks (each with a `difficulty` field), pick the
 * one whose difficulty is closest to the scheduler's next target.
 */
export function recommendNextTask(tasks, curriculum) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const scheduler =
    curriculum instanceof CurriculumScheduler
      ? curriculum
      : CurriculumScheduler.fromJSON(curriculum || {});
  const target = scheduler.nextDifficulty();
  let best = null;
  let bestDelta = Infinity;
  for (const task of tasks) {
    const d = typeof task?.difficulty === "number" ? task.difficulty : 0.5;
    const delta = Math.abs(d - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = task;
    }
  }
  return { task: best, targetDifficulty: target, delta: bestDelta };
}

// ─── Reports ────────────────────────────────────────────────────────────────

export async function generateProgressReport(curriculumName) {
  const rec = await getCurriculum(curriculumName);
  if (!rec) return null;
  const scheduler = CurriculumScheduler.fromJSON(rec);
  const progress = scheduler.getProgress();
  const plateau = detectPlateau(progress.history, 10);
  const history = progress.history;
  let earliestSkill = progress.currentSkill;
  if (history.length > 0 && typeof history[0].skillAfter === "number") {
    earliestSkill = history[0].skillAfter;
  }
  const totalSuccesses = history.filter((s) => s.success).length;
  const overallSuccessRate = history.length ? totalSuccesses / history.length : 0;
  return {
    name: rec.name,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    samples: progress.samples,
    currentSkill: progress.currentSkill,
    startingSkill: earliestSkill,
    trend: progress.trend,
    avgDifficulty: progress.avgDifficulty,
    recentSuccessRate: progress.recentSuccessRate,
    overallSuccessRate,
    plateau,
    nextDifficulty: scheduler.nextDifficulty(),
    targetSuccessRate: scheduler.targetSuccessRate,
  };
}
