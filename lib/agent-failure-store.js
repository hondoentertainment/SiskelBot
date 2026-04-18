/**
 * Per-workspace persistent failure-category stats.
 *
 * Aggregates (tool, category) counts across agent runs so:
 *   - admins can see chronically broken tools
 *   - agents can bias against tools that have failed repeatedly with
 *     terminal errors (permission, not_allowed, unknown_tool)
 *
 * Storage: one JSON blob per workspace at
 *   data/agent-failures/<workspace>/stats.json
 * Routed through the same JSON → SQLite → Postgres backend as the rest of
 * the app via json-path-store.
 *
 * @module agent-failure-store
 */

import { join } from "path";
import { readJsonPath, writeJsonPath, getDataDir } from "./json-path-store.js";

const MAX_TOOLS_PER_WORKSPACE = 500;

/**
 * @typedef {object} FailureStats
 * @property {number} total
 * @property {number} lastTs
 * @property {Record<string, number>} byCategory - category -> count
 */

/**
 * @typedef {object} WorkspaceStats
 * @property {number} version
 * @property {number} updatedAt
 * @property {Record<string, FailureStats>} tools - toolName -> stats
 */

function sanitizeSegment(s) {
  if (typeof s !== "string" || s.length === 0) return "default";
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function storePath(workspace) {
  const ws = sanitizeSegment(workspace);
  return join(getDataDir(), "agent-failures", ws, "stats.json");
}

function emptyStats() {
  return { version: 1, updatedAt: 0, tools: {} };
}

/**
 * Load persisted failure stats for a workspace.
 * @param {string} workspace
 * @returns {Promise<WorkspaceStats>}
 */
export async function loadFailureStats(workspace) {
  const path = storePath(workspace);
  const raw = await readJsonPath(path, emptyStats());
  if (!raw || typeof raw !== "object" || !raw.tools) return emptyStats();
  return raw;
}

/**
 * Record one failure for (workspace, tool, category).
 *
 * @param {string} workspace
 * @param {string} toolName
 * @param {string} category
 * @returns {Promise<WorkspaceStats>}
 */
export async function recordFailure(workspace, toolName, category) {
  if (!toolName || !category) return loadFailureStats(workspace);
  const path = storePath(workspace);
  const stats = await loadFailureStats(workspace);
  const now = Date.now();

  let toolStats = stats.tools[toolName];
  if (!toolStats) {
    toolStats = { total: 0, lastTs: 0, byCategory: {} };
    stats.tools[toolName] = toolStats;
  }
  toolStats.total += 1;
  toolStats.lastTs = now;
  toolStats.byCategory[category] = (toolStats.byCategory[category] || 0) + 1;
  stats.updatedAt = now;

  if (Object.keys(stats.tools).length > MAX_TOOLS_PER_WORKSPACE) {
    pruneOldTools(stats);
  }

  await writeJsonPath(path, stats);
  return stats;
}

/**
 * Record multiple failures in a single write (one per agent run).
 *
 * @param {string} workspace
 * @param {Array<{ tool: string; category: string }>} failures
 * @returns {Promise<WorkspaceStats>}
 */
export async function recordRunFailures(workspace, failures) {
  if (!Array.isArray(failures) || failures.length === 0) return loadFailureStats(workspace);
  const path = storePath(workspace);
  const stats = await loadFailureStats(workspace);
  const now = Date.now();

  for (const f of failures) {
    if (!f || typeof f.tool !== "string" || typeof f.category !== "string") continue;
    if (!f.tool || !f.category) continue;
    let t = stats.tools[f.tool];
    if (!t) {
      t = { total: 0, lastTs: 0, byCategory: {} };
      stats.tools[f.tool] = t;
    }
    t.total += 1;
    t.lastTs = now;
    t.byCategory[f.category] = (t.byCategory[f.category] || 0) + 1;
  }
  stats.updatedAt = now;
  if (Object.keys(stats.tools).length > MAX_TOOLS_PER_WORKSPACE) pruneOldTools(stats);

  await writeJsonPath(path, stats);
  return stats;
}

/**
 * Return a ranked list of chronically-failing tools for a workspace.
 * Ranked by terminal-category count (permission/not_allowed/unknown_tool
 * weight more than network/rate_limit).
 *
 * @param {string} workspace
 * @param {number} [limit=10]
 * @returns {Promise<Array<{ tool: string; total: number; score: number; byCategory: Record<string, number> }>>}
 */
export async function rankChronicFailures(workspace, limit = 10) {
  const stats = await loadFailureStats(workspace);
  const entries = Object.entries(stats.tools).map(([tool, s]) => ({
    tool,
    total: s.total,
    byCategory: s.byCategory,
    score: chronicScore(s),
  }));
  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, Math.max(1, limit));
}

/**
 * Is this (tool, workspace) marked as chronically broken?
 * Used to prompt the agent to avoid it in the system nudge.
 *
 * @param {string} workspace
 * @param {string} toolName
 * @param {object} [opts]
 * @param {number} [opts.minTerminalCount=3] - terminal failures before flagging
 * @returns {Promise<{ chronic: boolean; terminalCount: number; dominantCategory: string | null }>}
 */
export async function isChronicallyBroken(workspace, toolName, opts = {}) {
  const minTerminal = Number(opts.minTerminalCount) || 3;
  const stats = await loadFailureStats(workspace);
  const s = stats.tools[toolName];
  if (!s) return { chronic: false, terminalCount: 0, dominantCategory: null };

  const terminalCats = ["permission", "not_allowed", "unknown_tool", "validation"];
  let terminalCount = 0;
  let dominant = null;
  let dominantCount = 0;
  for (const [cat, count] of Object.entries(s.byCategory)) {
    if (terminalCats.includes(cat)) terminalCount += count;
    if (count > dominantCount) {
      dominant = cat;
      dominantCount = count;
    }
  }
  return {
    chronic: terminalCount >= minTerminal,
    terminalCount,
    dominantCategory: dominant,
  };
}

/**
 * Delete the stats file for a workspace (for tests / admin reset).
 * @param {string} workspace
 */
export async function resetFailureStats(workspace) {
  const path = storePath(workspace);
  await writeJsonPath(path, emptyStats());
}

/* -------------------------------------------------------------------------- */

function chronicScore(s) {
  const weights = {
    permission: 5,
    not_allowed: 5,
    unknown_tool: 5,
    validation: 3,
    backend_error: 2,
    timeout: 1,
    rate_limit: 1,
    network: 1,
    not_found: 1,
    semantic: 2,
    cancelled: 0,
    unknown: 1,
  };
  let score = 0;
  for (const [cat, count] of Object.entries(s.byCategory || {})) {
    score += (weights[cat] ?? 1) * count;
  }
  return score;
}

function pruneOldTools(stats) {
  const entries = Object.entries(stats.tools);
  entries.sort((a, b) => (a[1].lastTs || 0) - (b[1].lastTs || 0));
  const dropCount = entries.length - MAX_TOOLS_PER_WORKSPACE;
  for (let i = 0; i < dropCount; i++) {
    delete stats.tools[entries[i][0]];
  }
}
