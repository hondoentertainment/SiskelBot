/**
 * Phase 52.2: Self-consistency voting.
 *
 * Multi-sample reasoning with answer aggregation. Samples multiple
 * reasoning paths from a sampler function (typically an LLM), extracts
 * canonical answers, and votes to produce a consensus answer with a
 * confidence score.
 *
 * Storage: data/self-consistency/runs.jsonl — append-only log of runs.
 */
import { randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  appendFileSync,
} from "fs";
import { join, dirname } from "path";

const DEFAULT_N = 5;
const DEFAULT_MIN_CONSENSUS = 0.5;

function getDataDir() {
  return process.env.STORAGE_PATH || join(process.cwd(), "data");
}

function getRunsFilePath() {
  return join(getDataDir(), "self-consistency", "runs.jsonl");
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Sample multiple reasoning paths from a sampler function.
 *
 * @param {any} task Prompt / task passed to the sampler.
 * @param {Function} samplerFn async (task, options) => { answer, reasoning }
 * @param {number} n Number of samples.
 * @param {object} options Passed through to samplerFn.
 * @returns {Promise<Array<{answer: any, reasoning: string, sampleId: string, confidence?: number}>>}
 */
export async function sampleMultiple(task, samplerFn, n = DEFAULT_N, options = {}) {
  if (typeof samplerFn !== "function") {
    throw new Error("samplerFn must be a function");
  }
  const count = Math.max(1, Math.floor(Number(n) || DEFAULT_N));
  const samples = [];
  const parallel = options.parallel !== false;
  const runOne = async (i) => {
    try {
      const out = await samplerFn(task, { ...options, sampleIndex: i });
      return {
        sampleId: out?.sampleId || `sample-${i}-${randomUUID().slice(0, 8)}`,
        answer: out?.answer ?? null,
        reasoning: typeof out?.reasoning === "string" ? out.reasoning : "",
        confidence: typeof out?.confidence === "number" ? out.confidence : undefined,
        raw: out?.raw,
      };
    } catch (err) {
      return {
        sampleId: `sample-${i}-error`,
        answer: null,
        reasoning: "",
        error: err?.message || String(err),
      };
    }
  };
  if (parallel) {
    const results = await Promise.all(Array.from({ length: count }, (_, i) => runOne(i)));
    samples.push(...results);
  } else {
    for (let i = 0; i < count; i++) {
      // eslint-disable-next-line no-await-in-loop
      samples.push(await runOne(i));
    }
  }
  return samples;
}

/**
 * Extract a canonical answer from a free-form response string.
 *
 * @param {string} response Raw response text.
 * @param {string|object} format "auto" | "number" | "choice" | "json" | "boolean" | "regex"
 *                               If object: { type: "regex", pattern: string }
 *                               or { type: "choice", choices: [...] }
 * @returns {any}
 */
export function extractAnswer(response, format = "auto") {
  if (response == null) return null;
  const text = typeof response === "string" ? response : String(response);
  const fmt = typeof format === "string" ? { type: format } : format || { type: "auto" };
  const type = fmt.type || "auto";

  if (type === "number") {
    // Prefer "answer is <num>" style; fall back to last number in string.
    const m =
      text.match(/(?:answer|result|final)\s*(?:is|:)\s*(-?\d+(?:\.\d+)?)/i) ||
      text.match(/(-?\d+(?:\.\d+)?)(?!.*\d)/s);
    if (m) {
      const num = Number(m[1]);
      return Number.isFinite(num) ? num : null;
    }
    return null;
  }

  if (type === "boolean") {
    const lower = text.toLowerCase();
    const trueMatch = /\b(yes|true|correct|right|affirmative)\b/.test(lower);
    const falseMatch = /\b(no|false|incorrect|wrong|negative)\b/.test(lower);
    if (trueMatch && !falseMatch) return true;
    if (falseMatch && !trueMatch) return false;
    // If both, prefer the one that appears last (most recent conclusion).
    if (trueMatch && falseMatch) {
      const tIdx = lower.search(/\b(yes|true|correct|right|affirmative)\b/);
      const fIdx = lower.search(/\b(no|false|incorrect|wrong|negative)\b/);
      // Find the last occurrence of each.
      const lastTrue = lower.lastIndexOf(lower.match(/\b(yes|true|correct|right|affirmative)\b/)[0]);
      const lastFalse = lower.lastIndexOf(lower.match(/\b(no|false|incorrect|wrong|negative)\b/)[0]);
      return lastTrue > lastFalse;
    }
    return null;
  }

  if (type === "choice") {
    const choices = Array.isArray(fmt.choices) ? fmt.choices : [];
    if (choices.length === 0) {
      // Fallback: look for "A/B/C/D" style answer.
      const letter = text.match(/(?:answer|option)\s*(?:is|:)?\s*\(?([A-Z])\)?/i);
      if (letter) return letter[1].toUpperCase();
      return null;
    }
    const lower = text.toLowerCase();
    // Prefer choices that appear after "answer is"
    const answerCtx = text.match(/(?:answer|result|final)\s*(?:is|:)\s*([^\n.]+)/i);
    const searchIn = answerCtx ? answerCtx[1].toLowerCase() : lower;
    for (const c of choices) {
      if (searchIn.includes(String(c).toLowerCase())) return c;
    }
    for (const c of choices) {
      if (lower.includes(String(c).toLowerCase())) return c;
    }
    return null;
  }

  if (type === "json") {
    // Try to parse the whole string, then try fenced code block, then brace-match.
    try {
      return JSON.parse(text);
    } catch {
      /* fallthrough */
    }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        /* fallthrough */
      }
    }
    const braceStart = text.indexOf("{");
    const braceEnd = text.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(text.slice(braceStart, braceEnd + 1));
      } catch {
        /* fallthrough */
      }
    }
    const bracketStart = text.indexOf("[");
    const bracketEnd = text.lastIndexOf("]");
    if (bracketStart !== -1 && bracketEnd > bracketStart) {
      try {
        return JSON.parse(text.slice(bracketStart, bracketEnd + 1));
      } catch {
        /* fallthrough */
      }
    }
    return null;
  }

  if (type === "regex") {
    const pattern = fmt.pattern || fmt.regex;
    if (!pattern) return null;
    try {
      const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, fmt.flags || "");
      const m = text.match(re);
      if (!m) return null;
      return m[1] != null ? m[1] : m[0];
    } catch {
      return null;
    }
  }

  // auto: look for common "answer is" patterns, then "boxed{}", then final line.
  const answerIs = text.match(/(?:the\s+)?(?:final\s+)?answer\s*(?:is|:)\s*([^\n.]+)/i);
  if (answerIs) return answerIs[1].trim().replace(/[.!?]+$/, "");
  const boxed = text.match(/\\boxed\{([^}]+)\}/);
  if (boxed) return boxed[1].trim();
  // Fall back to the last non-empty line.
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) return lines[lines.length - 1];
  return text.trim();
}

/**
 * Normalize an answer for comparison: lowercase, trim, remove punctuation.
 *
 * @param {any} answer
 * @param {string} format
 * @returns {string}
 */
export function normalizeAnswer(answer, format = "auto") {
  if (answer == null) return "";
  if (format === "number" || typeof answer === "number") {
    const n = Number(answer);
    if (Number.isFinite(n)) {
      // Canonicalize 1.0 -> "1", 1.50 -> "1.5".
      return String(Number(n.toFixed(10))).replace(/\.?0+$/, "") || "0";
    }
  }
  if (format === "boolean" || typeof answer === "boolean") {
    return answer ? "true" : "false";
  }
  if (typeof answer === "object") {
    try {
      return JSON.stringify(sortKeys(answer));
    } catch {
      return String(answer);
    }
  }
  return String(answer)
    .toLowerCase()
    .trim()
    .replace(/[\p{P}$+<=>^`|~]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sortKeys(obj) {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
    return out;
  }
  return obj;
}

/**
 * Vote on answers using majority (plurality) rule.
 *
 * @param {Array<{answer:any, confidence?:number, sampleId?:string}>} samples
 * @param {object} options { format, weights, minConsensus }
 * @returns {{winner:any, votes:Object, confidence:number, consensusRate:number, totalVotes:number, rawWinner:any}}
 */
export function voteAnswers(samples, options = {}) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      winner: null,
      rawWinner: null,
      votes: {},
      confidence: 0,
      consensusRate: 0,
      totalVotes: 0,
    };
  }
  const format = options.format || "auto";
  const weights = Array.isArray(options.weights) ? options.weights : null;
  const votes = {};
  const rawMap = {}; // normalized -> raw first seen
  let total = 0;
  samples.forEach((s, i) => {
    if (s == null || s.answer == null) return;
    const norm = normalizeAnswer(s.answer, format);
    if (norm === "") return;
    const w = weights ? Number(weights[i]) || 0 : 1;
    if (w <= 0) return;
    votes[norm] = (votes[norm] || 0) + w;
    total += w;
    if (!(norm in rawMap)) rawMap[norm] = s.answer;
  });
  if (total === 0) {
    return { winner: null, rawWinner: null, votes: {}, confidence: 0, consensusRate: 0, totalVotes: 0 };
  }
  // Find max; tie-break by order of first appearance (deterministic).
  let winner = null;
  let winnerCount = -1;
  const order = Object.keys(votes);
  for (const key of order) {
    if (votes[key] > winnerCount) {
      winner = key;
      winnerCount = votes[key];
    }
  }
  const consensusRate = winnerCount / total;
  return {
    winner,
    rawWinner: rawMap[winner],
    votes,
    confidence: consensusRate,
    consensusRate,
    totalVotes: total,
  };
}

/**
 * Weighted vote — samples with higher weights count more.
 *
 * @param {Array} samples
 * @param {number[]} weights
 * @returns {object} Same shape as voteAnswers.
 */
export function weightedVote(samples, weights) {
  return voteAnswers(samples, { weights });
}

/**
 * Plurality winner: returns the key with the highest count.
 * @param {Object} votes { key: count }
 * @returns {string|null}
 */
export function plurality(votes) {
  if (!votes || typeof votes !== "object") return null;
  let winner = null;
  let max = -Infinity;
  for (const [k, v] of Object.entries(votes)) {
    if (v > max) {
      max = v;
      winner = k;
    }
  }
  return winner;
}

/**
 * Majority winner: returns the key whose count is above threshold of the total,
 * otherwise null.
 * @param {Object} votes
 * @param {number} threshold Fraction (0..1]
 * @returns {string|null}
 */
export function majority(votes, threshold = DEFAULT_MIN_CONSENSUS) {
  if (!votes || typeof votes !== "object") return null;
  const total = Object.values(votes).reduce((a, b) => a + (Number(b) || 0), 0);
  if (total <= 0) return null;
  const t = Number(threshold);
  const cutoff = Number.isFinite(t) && t > 0 && t <= 1 ? t : DEFAULT_MIN_CONSENSUS;
  for (const [k, v] of Object.entries(votes)) {
    if (v / total > cutoff) return k;
  }
  return null;
}

/**
 * Run the full self-consistency pipeline: sample N times, extract canonical
 * answers, vote, report consensus and confidence.
 *
 * @param {any} task
 * @param {Function} samplerFn
 * @param {object} options { n, format, scorer, minConsensus, weighted, persist }
 * @returns {Promise<object>}
 */
export async function runSelfConsistency(task, samplerFn, options = {}) {
  const n = Number(options.n) || DEFAULT_N;
  const format = options.format || "auto";
  const minConsensus = options.minConsensus != null ? Number(options.minConsensus) : DEFAULT_MIN_CONSENSUS;
  const rawSamples = await sampleMultiple(task, samplerFn, n, options);

  // Extract canonical answer from each sample; sampler may already supply one.
  const samples = rawSamples.map((s, i) => {
    let answer = s.answer;
    if ((answer == null || answer === "") && typeof s.reasoning === "string" && s.reasoning) {
      answer = extractAnswer(s.reasoning, format);
    }
    // Allow a scorer to set per-sample confidence/weights.
    let weight = 1;
    if (typeof options.scorer === "function") {
      try {
        const scored = options.scorer(s, i);
        if (typeof scored === "number") weight = scored;
        else if (scored && typeof scored.weight === "number") weight = scored.weight;
      } catch {
        /* ignore */
      }
    }
    return { ...s, answer, weight };
  });

  const weights = samples.map((s) => s.weight);
  const vote = options.weighted
    ? voteAnswers(samples, { format, weights })
    : voteAnswers(samples, { format });

  const agreement = analyzeAgreement(samples);
  const uncertainty = computeUncertainty(samples);
  const meetsConsensus = vote.consensusRate >= minConsensus;

  const runId = `scr-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const runResult = {
    runId,
    createdAt: new Date().toISOString(),
    task: typeof task === "string" ? task.slice(0, 2000) : task,
    n,
    format,
    answer: vote.rawWinner,
    normalizedAnswer: vote.winner,
    confidence: vote.confidence,
    consensus: meetsConsensus,
    consensusRate: vote.consensusRate,
    uncertainty,
    voteBreakdown: vote.votes,
    agreement,
    samples: samples.map((s) => ({
      sampleId: s.sampleId,
      answer: s.answer,
      reasoning: s.reasoning,
      weight: s.weight,
      confidence: s.confidence,
      error: s.error,
    })),
  };

  if (options.persist !== false) {
    try {
      await recordRun(runResult);
    } catch {
      /* persistence best-effort */
    }
  }

  return runResult;
}

/**
 * Analyze agreement across samples.
 *
 * @param {Array} samples
 * @returns {{uniqueAnswers:number, agreementRate:number, disagreementCategories:string[]}}
 */
export function analyzeAgreement(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { uniqueAnswers: 0, agreementRate: 0, disagreementCategories: [] };
  }
  const counts = {};
  let total = 0;
  for (const s of samples) {
    if (s == null || s.answer == null) continue;
    const k = normalizeAnswer(s.answer);
    if (k === "") continue;
    counts[k] = (counts[k] || 0) + 1;
    total += 1;
  }
  const unique = Object.keys(counts).length;
  const max = Object.values(counts).reduce((a, b) => (b > a ? b : a), 0);
  const agreementRate = total > 0 ? max / total : 0;
  const disagreementCategories = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  return { uniqueAnswers: unique, agreementRate, disagreementCategories };
}

/**
 * Shannon entropy over the answer distribution (natural units: bits).
 * Low entropy = high agreement. High entropy = high uncertainty.
 *
 * @param {Array} samples
 * @returns {number}
 */
export function computeUncertainty(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return 0;
  const counts = {};
  let total = 0;
  for (const s of samples) {
    if (s == null || s.answer == null) continue;
    const k = normalizeAnswer(s.answer);
    if (k === "") continue;
    counts[k] = (counts[k] || 0) + 1;
    total += 1;
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (const c of Object.values(counts)) {
    const p = c / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Pick the sample with the highest confidence score.
 * @param {Array} samples
 */
export function pickHighestConfidence(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const s of samples) {
    if (s == null) continue;
    const score = typeof s.confidence === "number" ? s.confidence : 0;
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

// ---- Persistence ----

/**
 * Persist a run result to the jsonl log.
 * @param {object} runResult
 */
export async function recordRun(runResult) {
  if (!runResult || typeof runResult !== "object") {
    throw new Error("runResult must be an object");
  }
  const filePath = getRunsFilePath();
  ensureDir(filePath);
  const record = {
    runId: runResult.runId || `scr-${Date.now()}-${randomUUID().slice(0, 8)}`,
    createdAt: runResult.createdAt || new Date().toISOString(),
    ...runResult,
  };
  appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  return record;
}

/**
 * Load run history with optional filters.
 * @param {object} filter { limit, since, task }
 */
export async function getRunHistory(filter = {}) {
  const filePath = getRunsFilePath();
  if (!existsSync(filePath)) return [];
  let lines;
  try {
    lines = readFileSync(filePath, "utf8").split(/\n/).filter(Boolean);
  } catch {
    return [];
  }
  const runs = [];
  for (const line of lines) {
    try {
      runs.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  let filtered = runs;
  if (filter.since) {
    const since = new Date(filter.since).getTime();
    if (Number.isFinite(since)) {
      filtered = filtered.filter((r) => new Date(r.createdAt).getTime() >= since);
    }
  }
  if (filter.task && typeof filter.task === "string") {
    const needle = filter.task.toLowerCase();
    filtered = filtered.filter(
      (r) => typeof r.task === "string" && r.task.toLowerCase().includes(needle),
    );
  }
  // Sort newest first.
  filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const limit = Number(filter.limit);
  if (Number.isFinite(limit) && limit > 0) filtered = filtered.slice(0, limit);
  return filtered;
}

export const _internals = {
  getRunsFilePath,
  sortKeys,
};
