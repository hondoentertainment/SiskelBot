// @ts-check
/**
 * Phase 56.4: Curriculum scheduler.
 *
 * Progressive difficulty scheduler for agent training runs. Each agent
 * has a "skill level" that rises on success and falls on failure; the
 * next task is selected from a pool whose difficulty brackets the
 * current skill. Supports multiple curricula per workspace, bands of
 * configurable width, and recency-weighted smoothing on the skill
 * score so a single failure doesn't crash the whole schedule.
 *
 * Exports:
 *   - createCurriculum(opts)
 *   - nextTask(curriculumId, agentId)
 *   - recordResult(curriculumId, agentId, result)
 *   - getSkillLevel(curriculumId, agentId)
 *   - adjustDifficulty(curriculumId, delta)
 *   - listCurricula()
 *
 * @module curriculum-scheduler
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 5;
const DEFAULT_SKILL = 2.5;
const DEFAULT_WINDOW = 10;
const DEFAULT_BAND_WIDTH = 1.0;

function storePath() {
  return join(getDataDir(), "curriculum-scheduler.json");
}

function now() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

async function loadStore() {
  const raw = await readJsonPath(storePath(), { version: STORE_VERSION, curricula: {} });
  if (!raw || typeof raw !== "object") return { version: STORE_VERSION, curricula: {} };
  if (!raw.curricula || typeof raw.curricula !== "object") raw.curricula = {};
  raw.version = STORE_VERSION;
  return raw;
}

async function saveStore(store) {
  await writeJsonPath(storePath(), { version: STORE_VERSION, curricula: store.curricula || {} });
}

/* -------------------------------------------------------------------------- */
/* Curriculum CRUD                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Create a curriculum pool from a list of tasks. Each task must have a
 * `difficulty` in [1,5]; optional `skill` lets you filter later.
 * @param {object} opts
 * @param {string} [opts.name]
 * @param {Array<{id?: string, difficulty: number, prompt?: string, skill?: string, expected?: string}>} opts.tasks
 * @param {number} [opts.bandWidth]
 * @param {number} [opts.initialSkill]
 * @param {number} [opts.window]
 */
export async function createCurriculum(opts) {
  if (!opts || typeof opts !== "object") throw new Error("opts required");
  if (!Array.isArray(opts.tasks) || opts.tasks.length === 0) {
    throw new Error("tasks array required");
  }
  const cur = {
    id: randomId("cur"),
    name: typeof opts.name === "string" && opts.name.trim() ? opts.name.trim() : "curriculum",
    bandWidth: Number.isFinite(opts.bandWidth) && opts.bandWidth > 0 ? opts.bandWidth : DEFAULT_BAND_WIDTH,
    initialSkill: Number.isFinite(opts.initialSkill)
      ? clamp(opts.initialSkill, MIN_DIFFICULTY, MAX_DIFFICULTY)
      : DEFAULT_SKILL,
    window: Number.isFinite(opts.window) && opts.window > 0 ? Math.floor(opts.window) : DEFAULT_WINDOW,
    tasks: opts.tasks.map((t, i) => ({
      id: t.id ? String(t.id) : `t${i}`,
      prompt: typeof t.prompt === "string" ? t.prompt : "",
      expected: t.expected != null ? String(t.expected) : null,
      difficulty: clamp(Number.isFinite(t.difficulty) ? t.difficulty : 3, MIN_DIFFICULTY, MAX_DIFFICULTY),
      skill: t.skill ? String(t.skill) : null,
    })),
    agents: /** @type {Record<string, any>} */ ({}),
    createdAt: now(),
    updatedAt: now(),
    version: 1,
  };
  await withPathLock(storePath(), async () => {
    const store = await loadStore();
    store.curricula[cur.id] = cur;
    await saveStore(store);
  });
  return cur;
}

/** List all curricula (metadata only). */
export async function listCurricula() {
  const store = await loadStore();
  return Object.values(store.curricula || {}).map((c) => ({
    id: c.id,
    name: c.name,
    taskCount: (c.tasks || []).length,
    bandWidth: c.bandWidth,
    initialSkill: c.initialSkill,
    createdAt: c.createdAt,
  }));
}

/* -------------------------------------------------------------------------- */
/* Skill state                                                                */
/* -------------------------------------------------------------------------- */

function agentState(cur, agentId) {
  if (!cur.agents[agentId]) {
    cur.agents[agentId] = {
      skill: cur.initialSkill,
      history: /** @type {Array<{taskId: string, correct: boolean, difficulty: number, at: string}>} */ ([]),
      seenTaskIds: /** @type {string[]} */ ([]),
      updatedAt: now(),
    };
  }
  return cur.agents[agentId];
}

/**
 * Read the current skill level for an agent.
 * @param {string} curriculumId
 * @param {string} agentId
 */
export async function getSkillLevel(curriculumId, agentId) {
  if (!curriculumId || !agentId) throw new Error("curriculumId and agentId required");
  const store = await loadStore();
  const cur = store.curricula[curriculumId];
  if (!cur) throw new Error(`curriculum "${curriculumId}" not found`);
  const st = cur.agents[agentId];
  if (!st) return { agentId, skill: cur.initialSkill, band: difficultyBand(cur.initialSkill, cur.bandWidth), history: [] };
  return {
    agentId,
    skill: Math.round(st.skill * 1000) / 1000,
    band: difficultyBand(st.skill, cur.bandWidth),
    history: st.history.slice(-cur.window),
  };
}

function difficultyBand(skill, bandWidth) {
  const lo = clamp(skill - bandWidth / 2, MIN_DIFFICULTY, MAX_DIFFICULTY);
  const hi = clamp(skill + bandWidth / 2, MIN_DIFFICULTY, MAX_DIFFICULTY);
  return { lo: Math.round(lo * 100) / 100, hi: Math.round(hi * 100) / 100 };
}

/* -------------------------------------------------------------------------- */
/* Task selection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pick the next task for an agent based on their current skill.
 * Tasks inside the band are preferred; if none match, we widen the
 * search symmetrically until one is found.
 * @param {string} curriculumId
 * @param {string} agentId
 */
export async function nextTask(curriculumId, agentId) {
  if (!curriculumId || !agentId) throw new Error("curriculumId and agentId required");
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const cur = store.curricula[curriculumId];
    if (!cur) throw new Error(`curriculum "${curriculumId}" not found`);
    const st = agentState(cur, agentId);
    const seen = new Set(st.seenTaskIds);
    const tasks = cur.tasks.slice();

    // Prefer unseen tasks inside the band, widen on miss.
    let band = cur.bandWidth / 2;
    const pickInRange = () => {
      const lo = st.skill - band;
      const hi = st.skill + band;
      const inRange = tasks.filter((t) => t.difficulty >= lo && t.difficulty <= hi && !seen.has(t.id));
      if (inRange.length > 0) return inRange[0];
      return null;
    };
    let chosen = pickInRange();
    while (!chosen && band < MAX_DIFFICULTY) {
      band += cur.bandWidth / 2;
      chosen = pickInRange();
    }
    // All unseen exhausted: allow repeats within nearest band.
    if (!chosen) {
      tasks.sort((a, b) => Math.abs(a.difficulty - st.skill) - Math.abs(b.difficulty - st.skill));
      chosen = tasks[0] || null;
    }
    if (chosen) {
      if (!seen.has(chosen.id)) {
        st.seenTaskIds.push(chosen.id);
        if (st.seenTaskIds.length > 10000) st.seenTaskIds.shift();
      }
      cur.updatedAt = now();
      store.curricula[curriculumId] = cur;
      await saveStore(store);
    }
    return chosen;
  });
}

/**
 * Record a task result; skill rises on success and falls on failure,
 * proportional to the difficulty distance.
 * @param {string} curriculumId
 * @param {string} agentId
 * @param {{taskId: string, correct: boolean}} result
 */
export async function recordResult(curriculumId, agentId, result) {
  if (!curriculumId || !agentId) throw new Error("curriculumId and agentId required");
  if (!result || typeof result !== "object" || !result.taskId) {
    throw new Error("result.taskId required");
  }
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const cur = store.curricula[curriculumId];
    if (!cur) throw new Error(`curriculum "${curriculumId}" not found`);
    const task = cur.tasks.find((t) => t.id === result.taskId);
    if (!task) throw new Error(`task "${result.taskId}" not in curriculum`);
    const st = agentState(cur, agentId);
    const correct = !!result.correct;
    const diff = task.difficulty;
    // Base skill update with an Elo-ish formula: the harder the task,
    // the bigger the reward for success (or reward for failing an
    // easier task).
    const expected = 1 / (1 + Math.exp(-(st.skill - diff)));
    const kFactor = 0.5;
    const update = kFactor * ((correct ? 1 : 0) - expected);
    st.skill = clamp(st.skill + update, MIN_DIFFICULTY, MAX_DIFFICULTY);
    st.history.push({
      taskId: task.id,
      correct,
      difficulty: diff,
      at: now(),
    });
    if (st.history.length > cur.window * 10) st.history = st.history.slice(-cur.window * 10);
    st.updatedAt = now();
    cur.updatedAt = st.updatedAt;
    store.curricula[curriculumId] = cur;
    await saveStore(store);
    return {
      agentId,
      skill: Math.round(st.skill * 1000) / 1000,
      update: Math.round(update * 1000) / 1000,
      band: difficultyBand(st.skill, cur.bandWidth),
    };
  });
}

/**
 * Globally shift a curriculum's initial skill (and, optionally, every
 * agent's current skill) by `delta`.
 * @param {string} curriculumId
 * @param {number} delta
 * @param {object} [opts]
 */
export async function adjustDifficulty(curriculumId, delta, opts = {}) {
  if (!curriculumId) throw new Error("curriculumId required");
  if (!Number.isFinite(delta)) throw new Error("delta must be a number");
  return withPathLock(storePath(), async () => {
    const store = await loadStore();
    const cur = store.curricula[curriculumId];
    if (!cur) throw new Error(`curriculum "${curriculumId}" not found`);
    cur.initialSkill = clamp(cur.initialSkill + delta, MIN_DIFFICULTY, MAX_DIFFICULTY);
    if (opts && opts.applyToAgents) {
      for (const st of Object.values(cur.agents)) {
        st.skill = clamp(st.skill + delta, MIN_DIFFICULTY, MAX_DIFFICULTY);
        st.updatedAt = now();
      }
    }
    cur.updatedAt = now();
    store.curricula[curriculumId] = cur;
    await saveStore(store);
    return { id: curriculumId, initialSkill: cur.initialSkill };
  });
}
