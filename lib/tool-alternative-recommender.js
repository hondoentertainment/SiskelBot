/**
 * Tool alternative recommender.
 *
 * When a tool call fails (especially permanently), the agent loop needs to
 * propose a different tool rather than just saying "try another tool". This
 * module ranks alternative tools currently exposed to the agent using:
 *   1. Historical per-tool success rate in this workspace (from agent-genealogy)
 *   2. Keyword overlap between the user's task text and the tool name
 *
 * Scoring is a simple multiplicative combination:
 *   score = keywordBonus * smoothedSuccessRate * sampleSizeConfidence
 *
 * where:
 *   keywordBonus         = 1.0 if tool name shares a keyword with task, else 0.5
 *   smoothedSuccessRate  = Laplace-smoothed success rate from genealogy
 *   sampleSizeConfidence = min(1, log10(sampleSize + 1))  -- saturates at n=9
 *
 * Returns up to `limit` alternatives with human-readable `reason` strings,
 * sorted best-first. Designed to be called from the agent re-plan path.
 *
 * @module tool-alternative-recommender
 */

import {
  loadToolOutcomes,
  getToolReliability,
  extractTaskKeywords,
  toolMatchesTask,
} from "./agent-genealogy.js";

/**
 * @typedef {import("./agent-genealogy.js").GenealogyStats} GenealogyStats
 */

/**
 * @typedef {object} Recommendation
 * @property {string} tool
 * @property {string} reason
 * @property {number} score
 */

/**
 * @typedef {object} Candidate
 * @property {string} tool
 * @property {number} score
 * @property {object} breakdown
 * @property {number} breakdown.keywordBonus
 * @property {number} breakdown.successRate
 * @property {number} breakdown.sampleSize
 * @property {number} breakdown.confidence
 * @property {boolean} breakdown.keywordMatch
 */

/**
 * Is the recommender enabled? Defaults ON because it reads existing data only.
 * Flip off with AGENT_TOOL_ALTERNATIVE_RECOMMEND=0.
 * @returns {boolean}
 */
export function recommenderEnabled() {
  return process.env.AGENT_TOOL_ALTERNATIVE_RECOMMEND !== "0";
}

/**
 * Pure scoring helper (no I/O). Given genealogy stats + task keywords, score
 * every candidate tool. Exported for tests.
 *
 * @param {object} params
 * @param {GenealogyStats | null} params.genealogyStats
 * @param {string} params.failedToolName
 * @param {string} params.taskText
 * @param {Set<string> | string[] | null | undefined} params.availableTools
 * @param {number} [params.minSamples=3]
 * @returns {Candidate[]}
 */
export function scoreCandidates({ genealogyStats, failedToolName, taskText, availableTools, minSamples = 3 }) {
  const available = toSet(availableTools);
  if (available.size === 0) return [];

  const threshold = Number.isFinite(minSamples) && minSamples >= 0 ? minSamples : 3;
  const taskTokens = extractTaskKeywords(typeof taskText === "string" ? taskText : "");

  /** @type {Candidate[]} */
  const out = [];

  for (const tool of available) {
    if (typeof tool !== "string" || !tool) continue;
    if (tool === failedToolName) continue;

    const rel = getToolReliability(genealogyStats, tool);
    if (rel.sampleSize < threshold) continue;

    const keywordMatch = taskTokens.size > 0 && toolMatchesTask(tool, taskTokens);
    const keywordBonus = keywordMatch ? 1.0 : 0.5;
    const confidence = Math.min(1, Math.log10(rel.sampleSize + 1));
    const score = keywordBonus * rel.successRate * confidence;

    out.push({
      tool,
      score,
      breakdown: {
        keywordBonus,
        successRate: rel.successRate,
        sampleSize: rel.sampleSize,
        confidence,
        keywordMatch,
      },
    });
  }

  // Sort best-first; deterministic tie-break by sampleSize desc then name asc.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.breakdown.sampleSize !== a.breakdown.sampleSize) {
      return b.breakdown.sampleSize - a.breakdown.sampleSize;
    }
    return a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;
  });

  return out;
}

/**
 * Recommend alternative tools for a failing tool, based on persisted genealogy.
 *
 * @param {object} params
 * @param {string} params.workspace
 * @param {string} params.failedToolName
 * @param {string} params.taskText
 * @param {Set<string> | string[]} params.availableTools
 * @param {object} [params.opts]
 * @param {number} [params.opts.limit=3]
 * @param {number} [params.opts.minSamples=3]
 * @returns {Promise<Recommendation[]>}
 */
export async function recommendAlternatives({ workspace, failedToolName, taskText, availableTools, opts = {} }) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 3;
  const minSamples = Number.isFinite(opts.minSamples) && opts.minSamples >= 0 ? Math.floor(opts.minSamples) : 3;

  const available = toSet(availableTools);
  if (available.size === 0) return [];

  let stats;
  try {
    stats = await loadToolOutcomes(workspace || "default");
  } catch {
    stats = null;
  }

  const scored = scoreCandidates({
    genealogyStats: stats,
    failedToolName,
    taskText,
    availableTools: available,
    minSamples,
  });
  if (scored.length === 0) return [];

  const taskTokens = extractTaskKeywords(typeof taskText === "string" ? taskText : "");

  const top = scored.slice(0, limit);
  return top.map((c) => ({
    tool: c.tool,
    score: c.score,
    reason: buildReason(c, taskTokens),
  }));
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  return new Set();
}

/**
 * Build a reason string like:
 *   "87% success rate (n=34), matches task keyword 'search'"
 *   "92% success rate (n=50)"
 *
 * @param {Candidate} c
 * @param {Set<string>} taskTokens
 * @returns {string}
 */
function buildReason(c, taskTokens) {
  const pct = Math.round(c.breakdown.successRate * 100);
  const base = `${pct}% success rate (n=${c.breakdown.sampleSize})`;
  if (!c.breakdown.keywordMatch) return base;
  const matched = firstMatchingKeyword(c.tool, taskTokens);
  if (!matched) return base;
  return `${base}, matches task keyword '${matched}'`;
}

/**
 * Return the first task keyword that shows up (directly or via prefix) in the
 * tool name. Returns null when there's no readable match.
 * @param {string} toolName
 * @param {Set<string>} taskTokens
 * @returns {string | null}
 */
function firstMatchingKeyword(toolName, taskTokens) {
  if (!toolName || !taskTokens || taskTokens.size === 0) return null;
  const parts = toolName.toLowerCase().split(/[_\-\s]+/).filter(Boolean);
  for (const part of parts) {
    if (taskTokens.has(part)) return part;
  }
  for (const part of parts) {
    for (const t of taskTokens) {
      if (t.length >= 4 && part.startsWith(t)) return t;
      if (part.length >= 4 && t.startsWith(part)) return part;
    }
  }
  return null;
}
