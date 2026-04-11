// @ts-check
/**
 * Phase 53.3: Progressive tool disclosure.
 *
 * Given a token budget and a natural-language task, select the minimal set
 * of tools to expose to the LLM. This is the "progressive" variant: tools
 * are layered into tiers (must-keep, highly-relevant, opportunistic) and the
 * final selection stops once the budget is exhausted.
 *
 * The module exposes:
 *   - `estimateToolTokenCost(tool)` -- approximate token count of schema + desc
 *   - `rankByRelevance(task, tools)` -- TF-IDF-ish scoring with usage tie-breaker
 *   - `selectToolsForBudget(task, tools, budget, opts)` -- greedy knapsack selection
 *   - `pruneToolSet(tools, keepNames)` -- strip tools not in the allowlist
 *
 * Named `tool-disclosure-progressive` to avoid collision with the older
 * `lib/tool-disclosure.js` module which uses a different API shape.
 *
 * @module tool-disclosure-progressive
 */
import { join } from "path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

const STORE_VERSION = 1;

/** Rough tokens-per-character ratio used when no tokenizer is wired in. */
const CHARS_PER_TOKEN = 4;

/** Absolute minimum tokens we assign to any tool (for the name line). */
const MIN_TOOL_TOKENS = 10;

const DEFAULT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by",
  "for", "from", "has", "have", "in", "is", "it", "of",
  "on", "or", "that", "the", "this", "to", "with", "i",
  "you", "we", "me", "my", "please", "kindly",
]);

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

function pinsPath() {
  return join(getDataDir(), "tool-disclosure-progressive-pins.json");
}

async function loadPins() {
  const data = await readJsonPath(pinsPath(), {
    version: STORE_VERSION,
    pins: [],
  });
  if (!data || typeof data !== "object") return { version: STORE_VERSION, pins: [] };
  if (!Array.isArray(data.pins)) data.pins = [];
  return data;
}

async function savePins(data) {
  await writeJsonPath(pinsPath(), {
    version: STORE_VERSION,
    pins: Array.isArray(data.pins) ? data.pins : [],
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Persist a list of always-disclose tool names. These bypass budget caps.
 * @param {string[]} names
 */
export async function setPinnedTools(names) {
  if (!Array.isArray(names)) throw new Error("names must be an array");
  const path = pinsPath();
  return withPathLock(path, async () => {
    const data = await loadPins();
    data.pins = [...new Set(names.map((n) => String(n)).filter(Boolean))];
    await savePins(data);
    return data.pins;
  });
}

/** Fetch the pinned tools list. */
export async function getPinnedTools() {
  const data = await loadPins();
  return Array.isArray(data.pins) ? [...data.pins] : [];
}

/* -------------------------------------------------------------------------- */
/* Token cost estimation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rough per-tool token count. Uses character / CHARS_PER_TOKEN with a
 * floor of MIN_TOOL_TOKENS so every included tool costs something.
 *
 * @param {{ name?: string, description?: string, parameters?: any, schema?: any }} tool
 * @returns {number}
 */
export function estimateToolTokenCost(tool) {
  if (!tool || typeof tool !== "object") return MIN_TOOL_TOKENS;
  const parts = [];
  if (tool.name) parts.push(String(tool.name));
  if (tool.description) parts.push(String(tool.description));
  const schema = tool.parameters || tool.schema;
  if (schema && typeof schema === "object") {
    try {
      parts.push(JSON.stringify(schema));
    } catch (_) {
      // circular or unserializable -- fall back to name-only
    }
  }
  const text = parts.join(" ");
  const est = Math.ceil(text.length / CHARS_PER_TOKEN);
  return Math.max(MIN_TOOL_TOKENS, est);
}

/* -------------------------------------------------------------------------- */
/* Relevance scoring                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Tokenize free-form text into lowercase word tokens with stopwords removed.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (text == null) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !DEFAULT_STOPWORDS.has(t));
}

/**
 * Build the searchable text for a tool record.
 * @param {{ name?: string, description?: string, tags?: string[], parameters?: any, schema?: any }} tool
 */
function toolText(tool) {
  if (!tool || typeof tool !== "object") return "";
  const parts = [];
  if (tool.name) parts.push(String(tool.name).replace(/_/g, " "));
  if (tool.description) parts.push(String(tool.description));
  if (Array.isArray(tool.tags)) parts.push(tool.tags.join(" "));
  const schema = tool.parameters || tool.schema;
  if (schema && schema.properties && typeof schema.properties === "object") {
    for (const [pname, pdef] of Object.entries(schema.properties)) {
      parts.push(String(pname).replace(/_/g, " "));
      if (pdef && typeof pdef === "object" && /** @type {any} */ (pdef).description) {
        parts.push(String(/** @type {any} */ (pdef).description));
      }
    }
  }
  return parts.join(" ");
}

/**
 * Rank a list of tools by relevance to a task. Returns the tools in descending
 * relevance order, each annotated with `relevance` and `matched` fields.
 *
 * @param {string} task
 * @param {Array<object>} tools
 * @param {{ usage?: Record<string, { uses?: number, successes?: number }> }} [opts]
 * @returns {Array<object>}
 */
export function rankByRelevance(task, tools, opts = {}) {
  if (!Array.isArray(tools)) return [];
  const qTokens = tokenize(task || "");
  const usage = opts.usage && typeof opts.usage === "object" ? opts.usage : {};

  // Precompute IDF-like weights from the tool corpus.
  /** @type {Record<string, number>} */
  const df = {};
  /** @type {Map<string, string[]>} */
  const toolTokens = new Map();
  for (const t of tools) {
    if (!t || !t.name) continue;
    const toks = tokenize(toolText(t));
    toolTokens.set(t.name, toks);
    const seen = new Set();
    for (const tok of toks) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      df[tok] = (df[tok] || 0) + 1;
    }
  }
  const N = tools.length;
  /** @type {Record<string, number>} */
  const idf = {};
  for (const [term, freq] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (freq + 1)) + 1;
  }

  /** @type {Array<object>} */
  const out = [];
  for (const t of tools) {
    if (!t || !t.name) continue;
    const docTokens = toolTokens.get(t.name) || [];
    /** @type {Record<string, number>} */
    const docTf = {};
    for (const tok of docTokens) docTf[tok] = (docTf[tok] || 0) + 1;
    let score = 0;
    const matched = [];
    for (const qt of qTokens) {
      if (docTf[qt]) {
        const w = idf[qt] || 1;
        score += (docTf[qt] / Math.max(1, docTokens.length)) * w * w;
        matched.push(qt);
      }
    }
    // Usage tie-breaker: log(1 + uses) scaled to < 0.5
    const st = usage[t.name] || {};
    const uses = Number(st.uses) || 0;
    const successes = Number(st.successes) || 0;
    const successRate = uses > 0 ? successes / uses : 0;
    const usageBump = Math.min(0.5, Math.log(1 + uses) * (0.3 + 0.2 * successRate));
    const finalScore = score + usageBump;
    out.push({
      ...t,
      relevance: Math.round(finalScore * 10000) / 10000,
      baseRelevance: Math.round(score * 10000) / 10000,
      usageBump: Math.round(usageBump * 10000) / 10000,
      matched,
    });
  }
  out.sort((a, b) => b.relevance - a.relevance || String(a.name).localeCompare(String(b.name)));
  return out;
}

/* -------------------------------------------------------------------------- */
/* Budget selection                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SelectOptions
 * @property {number} [minTools]   -- never return fewer than this many (unless total < minTools)
 * @property {string[]} [pinned]   -- these tools are always included, even if over-budget
 * @property {number} [reserveTokens] -- tokens to leave unallocated for the LLM itself
 * @property {Record<string, { uses?: number, successes?: number }>} [usage]
 */

/**
 * Select the minimal tool set that fits within `budget` tokens. Returns the
 * selected list plus a report of what was cut and why.
 *
 * @param {string} task
 * @param {Array<object>} tools
 * @param {number} budget
 * @param {SelectOptions} [opts]
 * @returns {{ selected: Array<object>, excluded: Array<object>, budget: number, used: number, reason: string }}
 */
export function selectToolsForBudget(task, tools, budget, opts = {}) {
  if (!Array.isArray(tools)) {
    return { selected: [], excluded: [], budget: 0, used: 0, reason: "no tools" };
  }
  const maxBudget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  const reserve = Number.isFinite(opts.reserveTokens) && opts.reserveTokens > 0
    ? Math.floor(opts.reserveTokens)
    : 0;
  const effectiveBudget = Math.max(0, maxBudget - reserve);
  const minTools = Number.isFinite(opts.minTools) && opts.minTools > 0 ? Math.floor(opts.minTools) : 0;
  const pinned = new Set(Array.isArray(opts.pinned) ? opts.pinned.map(String) : []);

  const ranked = rankByRelevance(task, tools, { usage: opts.usage });

  /** @type {Array<object>} */
  const selected = [];
  /** @type {Array<object>} */
  const excluded = [];
  let used = 0;

  // Pinned tools first (bypass budget).
  for (const t of ranked) {
    if (pinned.has(t.name)) {
      const cost = estimateToolTokenCost(t);
      selected.push({ ...t, estTokens: cost, reason: "pinned" });
      used += cost;
    }
  }

  // Greedy selection by relevance until the budget is exhausted.
  for (const t of ranked) {
    if (pinned.has(t.name)) continue;
    const cost = estimateToolTokenCost(t);
    if (selected.length < minTools || used + cost <= effectiveBudget) {
      selected.push({ ...t, estTokens: cost, reason: selected.length < minTools ? "min-tools" : "within-budget" });
      used += cost;
      continue;
    }
    excluded.push({ ...t, estTokens: cost, reason: `would exceed budget (${used + cost}/${effectiveBudget})` });
  }

  const reason = excluded.length === 0
    ? "all tools fit"
    : `${excluded.length} tool(s) excluded due to budget`;
  return { selected, excluded, budget: effectiveBudget, used, reason };
}

/* -------------------------------------------------------------------------- */
/* Pruning                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Return the subset of `tools` whose names are in `keepNames`.
 * Preserves the order of the original list.
 *
 * @param {Array<object>} tools
 * @param {string[]} keepNames
 */
export function pruneToolSet(tools, keepNames) {
  if (!Array.isArray(tools)) return [];
  const keep = new Set((Array.isArray(keepNames) ? keepNames : []).map(String));
  return tools.filter((t) => t && typeof t === "object" && keep.has(String(t.name)));
}
