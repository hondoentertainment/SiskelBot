/**
 * Cross-run decision genealogy: persistent per-workspace tool outcome stats.
 *
 * Each agent run reports (tool, outcome=success|failure) tuples. The store
 * aggregates them into per-tool success rates. At the start of a new run,
 * buildReliabilityHint() emits a compact summary that gets appended to the
 * system prompt so the LLM can bias toward historically reliable tools and
 * avoid tools that fail in this workspace.
 *
 * Storage: one JSON blob per workspace at
 *   data/agent-genealogy/<workspace>/outcomes.json
 *
 * This is complementary to agent-failure-store.js: that module counts
 * terminal failures by category; this module tracks overall success rates
 * and is what actually gets injected into the system prompt.
 *
 * @module agent-genealogy
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

const MAX_TOOLS = 500;
/** Laplace smoothing constant so tools with 1-2 samples aren't overconfident. */
const PRIOR_STRENGTH = 2;

/**
 * @typedef {object} ToolStats
 * @property {number} successes
 * @property {number} failures
 * @property {number} lastTs
 */

/**
 * @typedef {object} GenealogyStats
 * @property {number} version
 * @property {number} updatedAt
 * @property {Record<string, ToolStats>} tools
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function storePath(workspace) {
  return join(getDataDir(), "agent-genealogy", sanitizeSegment(workspace), "outcomes.json");
}

function empty() {
  return { version: 1, updatedAt: 0, tools: {} };
}

/**
 * Load persisted tool outcomes for a workspace.
 * @param {string} workspace
 * @returns {Promise<GenealogyStats>}
 */
export async function loadToolOutcomes(workspace) {
  const raw = await readJsonPath(storePath(workspace), empty());
  if (!raw || typeof raw !== "object" || !raw.tools) return empty();
  return raw;
}

/**
 * Bulk record an agent run's tool outcomes.
 *
 * @param {string} workspace
 * @param {Array<{ tool: string; ok: boolean }>} outcomes
 * @returns {Promise<GenealogyStats>}
 */
export async function recordToolOutcomes(workspace, outcomes) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return loadToolOutcomes(workspace);
  const path = storePath(workspace);
  const stats = await loadToolOutcomes(workspace);
  const now = Date.now();

  for (const o of outcomes) {
    if (!o || typeof o.tool !== "string" || !o.tool) continue;
    let t = stats.tools[o.tool];
    if (!t) {
      t = { successes: 0, failures: 0, lastTs: 0 };
      stats.tools[o.tool] = t;
    }
    if (o.ok) t.successes += 1; else t.failures += 1;
    t.lastTs = now;
  }

  stats.updatedAt = now;
  if (Object.keys(stats.tools).length > MAX_TOOLS) pruneOldest(stats);
  await writeJsonPath(path, stats);
  return stats;
}

/**
 * Return the Laplace-smoothed success rate and sample size for a tool.
 * @param {GenealogyStats | null} stats
 * @param {string} toolName
 * @returns {{ successRate: number; sampleSize: number; successes: number; failures: number }}
 */
export function getToolReliability(stats, toolName) {
  const t = stats?.tools?.[toolName];
  if (!t) {
    return { successRate: 0.5, sampleSize: 0, successes: 0, failures: 0 };
  }
  const n = t.successes + t.failures;
  // Laplace smoothing with a symmetric prior mean of 0.5.
  const rate = (t.successes + PRIOR_STRENGTH / 2) / (n + PRIOR_STRENGTH);
  return {
    successRate: rate,
    sampleSize: n,
    successes: t.successes,
    failures: t.failures,
  };
}

/**
 * Rank tools by smoothed success rate (descending), with sampleSize as tiebreak.
 *
 * @param {GenealogyStats} stats
 * @param {object} [opts]
 * @param {number} [opts.minSamples=1] - drop tools with fewer samples
 * @returns {Array<{ tool: string; successRate: number; sampleSize: number; successes: number; failures: number }>}
 */
export function rankByReliability(stats, opts = {}) {
  const minSamples = Number(opts.minSamples) || 1;
  const out = [];
  for (const tool of Object.keys(stats.tools || {})) {
    const r = getToolReliability(stats, tool);
    if (r.sampleSize < minSamples) continue;
    out.push({ tool, ...r });
  }
  out.sort((a, b) => (b.successRate - a.successRate) || (b.sampleSize - a.sampleSize));
  return out;
}

/**
 * Build a compact text hint to prepend to the agent's system prompt, biasing
 * it toward historically reliable tools and away from chronic failures.
 *
 * Returns empty string if there's not enough signal to be useful.
 *
 * @param {string} workspace
 * @param {object} [opts]
 * @param {number} [opts.minSamples=3] - tools must have at least this many samples to cite
 * @param {number} [opts.avoidBelow=0.3] - success rate threshold for explicit avoidance
 * @param {number} [opts.preferAbove=0.8] - success rate threshold for explicit preference
 * @param {number} [opts.maxListed=5] - hard cap on listed tools in each bucket
 * @returns {Promise<string>}
 */
export async function buildReliabilityHint(workspace, opts = {}) {
  const minSamples = Number(opts.minSamples) || 3;
  const avoidBelow = typeof opts.avoidBelow === "number" ? opts.avoidBelow : 0.3;
  const preferAbove = typeof opts.preferAbove === "number" ? opts.preferAbove : 0.8;
  const maxListed = Number(opts.maxListed) || 5;

  const stats = await loadToolOutcomes(workspace);
  if (!stats.tools || Object.keys(stats.tools).length === 0) return "";

  const ranked = rankByReliability(stats, { minSamples });
  if (ranked.length === 0) return "";

  const prefer = ranked.filter((r) => r.successRate >= preferAbove).slice(0, maxListed);
  const avoid = ranked.filter((r) => r.successRate <= avoidBelow).slice(-maxListed);

  if (prefer.length === 0 && avoid.length === 0) return "";

  const parts = ["Tool reliability in this workspace (from prior runs):"];
  if (prefer.length > 0) {
    parts.push(
      `High success: ${prefer
        .map((r) => `${r.tool} (${pct(r.successRate)}, n=${r.sampleSize})`)
        .join(", ")}. Prefer these when multiple tools could satisfy the task.`,
    );
  }
  if (avoid.length > 0) {
    parts.push(
      `Chronic failures: ${avoid
        .map((r) => `${r.tool} (${pct(r.successRate)}, n=${r.sampleSize})`)
        .join(", ")}. Avoid unless no alternative exists.`,
    );
  }
  return parts.join(" ");
}

/**
 * Delete the genealogy file for a workspace (for tests / admin reset).
 * @param {string} workspace
 */
export async function resetGenealogy(workspace) {
  await writeJsonPath(storePath(workspace), empty());
}

/* -------------------------------------------------------------------------- */

function pruneOldest(stats) {
  const entries = Object.entries(stats.tools);
  entries.sort((a, b) => (a[1].lastTs || 0) - (b[1].lastTs || 0));
  const dropCount = entries.length - MAX_TOOLS;
  for (let i = 0; i < dropCount; i++) delete stats.tools[entries[i][0]];
}

function pct(p) {
  return `${Math.round(p * 100)}%`;
}
