// @ts-check
/**
 * Phase 65.5: AI risk scoring (NIST AI RMF).
 *
 * Scores an AI system across the four NIST AI RMF functions:
 *   - GOVERN: policy, accountability, oversight
 *   - MAP:    context, purpose, impacted parties
 *   - MEASURE: evaluation, metrics, monitoring
 *   - MANAGE: response, remediation, incident handling
 *
 * Each dimension has a set of weighted subquestions scored 0-5. The
 * aggregate score is normalized to 0-100 with an overall risk level:
 *   - 0-40   critical
 *   - 41-60  high
 *   - 61-80  medium
 *   - 81-100 low
 *
 * Exports:
 *   - scoreSystem
 *   - listDimensions
 *   - getRiskReport
 *   - recordAssessment
 *   - listAssessments
 *
 * @module ai-risk-scoring
 */
import { join } from "path";
import { randomBytes } from "crypto";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

const DIMENSIONS = Object.freeze({
  govern: {
    key: "govern",
    title: "Govern",
    description: "Policies, accountability, oversight, and workforce diversity.",
    questions: Object.freeze([
      { id: "gov_policy", text: "Documented AI policies exist", weight: 1 },
      { id: "gov_accountability", text: "Clear accountability for AI decisions", weight: 1 },
      { id: "gov_oversight", text: "Independent oversight / review board", weight: 1 },
      { id: "gov_training", text: "Staff trained on AI risk", weight: 0.75 },
    ]),
  },
  map: {
    key: "map",
    title: "Map",
    description: "Context, intended use, impacted stakeholders, risk cataloging.",
    questions: Object.freeze([
      { id: "map_use_case", text: "Use case and purpose documented", weight: 1 },
      { id: "map_stakeholders", text: "Impacted stakeholders identified", weight: 1 },
      { id: "map_risks", text: "Known risks cataloged", weight: 1 },
      { id: "map_dependencies", text: "Third-party dependencies mapped", weight: 0.75 },
    ]),
  },
  measure: {
    key: "measure",
    title: "Measure",
    description: "Evaluation, metrics, testing, and monitoring.",
    questions: Object.freeze([
      { id: "meas_evals", text: "Offline evaluations run regularly", weight: 1 },
      { id: "meas_fairness", text: "Fairness/bias metrics tracked", weight: 1 },
      { id: "meas_monitoring", text: "Online monitoring in production", weight: 1 },
      { id: "meas_redteam", text: "Red-team exercises performed", weight: 0.75 },
    ]),
  },
  manage: {
    key: "manage",
    title: "Manage",
    description: "Incident response, escalation, rollback, continuous improvement.",
    questions: Object.freeze([
      { id: "man_incident", text: "Incident response playbook exists", weight: 1 },
      { id: "man_rollback", text: "Rollback / kill-switch in place", weight: 1 },
      { id: "man_comms", text: "Stakeholder communication plan", weight: 0.75 },
      { id: "man_review", text: "Post-incident review cadence", weight: 1 },
    ]),
  },
});

function storePath() {
  return join(getDataDir(), "ai-risk-scoring.json");
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

async function loadStore() {
  const data = await readJsonPath(storePath(), {
    version: STORE_VERSION,
    assessments: {},
  });
  if (!data.assessments || typeof data.assessments !== "object") data.assessments = {};
  return data;
}

async function saveStore(data) {
  await writeJsonPath(storePath(), {
    version: STORE_VERSION,
    assessments: data.assessments || {},
  });
}

/**
 * Return the full dimension catalog.
 * @returns {Array<{key: string, title: string, description: string, questions: Array<{id: string, text: string, weight: number}>}>}
 */
export function listDimensions() {
  return Object.values(DIMENSIONS).map((d) => ({
    key: d.key,
    title: d.title,
    description: d.description,
    questions: d.questions.map((q) => ({ ...q })),
  }));
}

function clampScore(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 5) return 5;
  return v;
}

function levelForScore(score) {
  if (score <= 40) return "critical";
  if (score <= 60) return "high";
  if (score <= 80) return "medium";
  return "low";
}

/**
 * Score an AI system given answers to dimension questions.
 * `answers` is an object like:
 *   {
 *     govern: { gov_policy: 5, gov_accountability: 3, ... },
 *     map:    { map_use_case: 4, ... },
 *     ...
 *   }
 * Missing answers are treated as 0.
 *
 * @param {{name: string, version?: string, owner?: string, answers: Record<string, Record<string, number>>, notes?: string}} input
 * @returns {{
 *   systemName: string,
 *   version: string,
 *   owner: string,
 *   dimensions: Array<{key: string, title: string, rawScore: number, maxScore: number, normalized: number}>,
 *   overall: number,
 *   level: string,
 *   recommendations: string[]
 * }}
 */
export function scoreSystem(input) {
  if (!input || typeof input !== "object") throw new Error("input required");
  if (!input.name) throw new Error("name is required");
  const answers = input.answers && typeof input.answers === "object" ? input.answers : {};

  const dims = [];
  let overallRaw = 0;
  let overallMax = 0;
  /** @type {string[]} */
  const recommendations = [];
  for (const dim of Object.values(DIMENSIONS)) {
    const dimAnswers = answers[dim.key] && typeof answers[dim.key] === "object" ? answers[dim.key] : {};
    let raw = 0;
    let max = 0;
    for (const q of dim.questions) {
      const score = clampScore(dimAnswers[q.id]);
      raw += score * q.weight;
      max += 5 * q.weight;
      if (score <= 2) {
        recommendations.push(`[${dim.title}] Improve: ${q.text}`);
      }
    }
    const normalized = max > 0 ? Math.round((raw / max) * 10000) / 100 : 0;
    overallRaw += raw;
    overallMax += max;
    dims.push({
      key: dim.key,
      title: dim.title,
      rawScore: Math.round(raw * 100) / 100,
      maxScore: Math.round(max * 100) / 100,
      normalized,
    });
  }
  const overall = overallMax > 0 ? Math.round((overallRaw / overallMax) * 10000) / 100 : 0;
  return {
    systemName: String(input.name),
    version: input.version ? String(input.version) : "",
    owner: input.owner ? String(input.owner) : "",
    dimensions: dims,
    overall,
    level: levelForScore(overall),
    recommendations,
  };
}

/**
 * Persist an assessment.
 *
 * @param {{name: string, version?: string, owner?: string, answers: object, notes?: string}} input
 * @returns {Promise<object>}
 */
export async function recordAssessment(input) {
  const scored = scoreSystem(input);
  const path = storePath();
  return withPathLock(path, async () => {
    const data = await loadStore();
    const id = newId("risk");
    const ts = nowIso();
    const record = {
      id,
      ...scored,
      notes: input.notes ? String(input.notes) : "",
      createdAt: ts,
    };
    data.assessments[id] = record;
    await saveStore(data);
    return record;
  });
}

/**
 * Generate a report for a given system (latest assessments and trends).
 *
 * @param {string} systemName
 * @returns {Promise<{systemName: string, latest: object|null, history: object[], trend: string}>}
 */
export async function getRiskReport(systemName) {
  if (!systemName) throw new Error("systemName required");
  const data = await loadStore();
  const history = Object.values(data.assessments || {})
    .filter((a) => a.systemName === systemName)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const latest = history.length > 0 ? history[history.length - 1] : null;
  let trend = "flat";
  if (history.length >= 2) {
    const prev = history[history.length - 2].overall;
    const cur = history[history.length - 1].overall;
    if (cur > prev + 1) trend = "improving";
    else if (cur < prev - 1) trend = "degrading";
  }
  return { systemName, latest, history, trend };
}

/**
 * List all persisted assessments.
 *
 * @param {{systemName?: string, level?: string, limit?: number}} [filter]
 * @returns {Promise<object[]>}
 */
export async function listAssessments(filter = {}) {
  const data = await loadStore();
  let all = Object.values(data.assessments || {});
  if (filter.systemName) {
    all = all.filter((a) => a.systemName === filter.systemName);
  }
  if (filter.level) {
    all = all.filter((a) => a.level === filter.level);
  }
  all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (Number.isFinite(filter.limit) && filter.limit > 0) {
    all = all.slice(0, Math.floor(filter.limit));
  }
  return all;
}
