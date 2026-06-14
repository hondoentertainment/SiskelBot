/**
 * Phase 53.3: Progressive tool disclosure.
 *
 * Context-budget-aware tool visibility. Agents with 100+ tools waste context
 * on tool descriptions — this module selects which tools to expose to the LLM
 * based on (a) current task relevance, (b) available token budget, (c) past
 * usage patterns.
 *
 * The selection pipeline:
 *   1. estimateToolTokens        — per-tool token cost on the JSON schema
 *   2. rankToolsForDisclosure    — relevance + past usage + recency score
 *   3. selectToolsWithinBudget   — greedy knapsack on the ranked list
 *   4. discloseTools             — end-to-end helper returning the final set
 *
 * State (essential-tool pins, disclosure stats) is persisted via
 * `json-path-store.js` so learning survives restarts.
 */
import { join } from "node:path";
import {
  readJsonPath,
  writeJsonPath,
  withPathLock,
  getDataDir,
} from "./json-path-store.js";

// ─── Paths ────────────────────────────────────────────────────────────────────

function essentialPath(workspaceId) {
  const scope = workspaceId || "_global";
  return join(getDataDir(), "tool-disclosure", `essential-${scope}.json`);
}

function statsPath(workspaceId) {
  const scope = workspaceId || "_global";
  return join(getDataDir(), "tool-disclosure", `stats-${scope}.json`);
}

// ─── Token estimation ────────────────────────────────────────────────────────

/**
 * Estimate how many tokens a tool definition consumes when serialized for the
 * LLM. We serialize to compact JSON and use the common "~4 chars per token"
 * heuristic — good enough for budget planning without a real tokenizer.
 *
 * @param {object} toolDef - Tool definition (OpenAI function format).
 * @returns {number} Token count (rounded up).
 */
export function estimateToolTokens(toolDef) {
  if (!toolDef || typeof toolDef !== "object") return 0;
  let json;
  try {
    json = JSON.stringify(toolDef);
  } catch {
    return 0;
  }
  if (!json) return 0;
  // A small fixed overhead accounts for role/delimiter tokens around the entry.
  return Math.ceil(json.length / 4) + 4;
}

/**
 * Given the model's max context window, return the budget available for
 * tool descriptions after reserving room for the output.
 *
 * @param {number} maxContextTokens
 * @param {number} [reservedForOutput=1000]
 * @returns {number}
 */
export function estimateBudget(maxContextTokens, reservedForOutput = 1000) {
  const max = Number.isFinite(maxContextTokens) ? Math.max(0, maxContextTokens) : 0;
  const reserve = Number.isFinite(reservedForOutput) ? Math.max(0, reservedForOutput) : 0;
  return Math.max(0, max - reserve);
}

// ─── Tool description helpers ────────────────────────────────────────────────

function getToolName(toolDef) {
  if (!toolDef || typeof toolDef !== "object") return "";
  if (typeof toolDef.name === "string") return toolDef.name;
  if (toolDef.function && typeof toolDef.function.name === "string") return toolDef.function.name;
  return "";
}

function getToolDescription(toolDef) {
  if (!toolDef || typeof toolDef !== "object") return "";
  if (typeof toolDef.description === "string") return toolDef.description;
  if (toolDef.function && typeof toolDef.function.description === "string") {
    return toolDef.function.description;
  }
  return "";
}

/**
 * Produce a shorter description: strips examples, caps length, keeps schema.
 * The caller may use this to shrink a tool's footprint when we are close to
 * the budget but still want to keep the entry.
 *
 * @param {object} toolDef
 * @returns {object}
 */
export function compactToolDescription(toolDef) {
  if (!toolDef || typeof toolDef !== "object") return toolDef;
  const clone = structuredClone(toolDef);
  const shrinkDesc = (d) => {
    if (typeof d !== "string") return d;
    // Remove "Example:" / "Examples:" blocks and trailing example hints.
    let out = d
      .replace(/Examples?:[\s\S]*$/i, "")
      .replace(/For example[^.]*\.?/gi, "")
      .replace(/e\.g\.?,?[^.]*\.?/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    if (out.length > 120) out = out.slice(0, 117).trim() + "...";
    return out;
  };
  if (typeof clone.description === "string") {
    clone.description = shrinkDesc(clone.description);
  }
  if (clone.function && typeof clone.function.description === "string") {
    clone.function.description = shrinkDesc(clone.function.description);
  }
  // Strip verbose param examples from JSON schema if present.
  const stripExamples = (schema) => {
    if (!schema || typeof schema !== "object") return;
    if ("examples" in schema) delete schema.examples;
    if ("example" in schema) delete schema.example;
    if (schema.properties && typeof schema.properties === "object") {
      for (const key of Object.keys(schema.properties)) {
        stripExamples(schema.properties[key]);
      }
    }
  };
  const params =
    clone.parameters || (clone.function && clone.function.parameters) || null;
  if (params) stripExamples(params);
  return clone;
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "has",
  "are", "was", "were", "will", "would", "should", "could", "into", "onto",
  "its", "but", "not", "all", "any", "some", "one", "two", "use", "used",
  "about", "over", "under", "when", "what", "which", "who", "whom", "how",
  "why", "your", "you", "our", "out", "off", "them", "they", "their",
]);

function tokenizeText(text) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function relevanceScore(toolDef, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const name = getToolName(toolDef).toLowerCase();
  const desc = getToolDescription(toolDef).toLowerCase();
  const haystack = `${name} ${desc}`;
  let hits = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    if (haystack.includes(kw)) hits += 1;
    if (name.includes(kw)) hits += 2; // Name matches count double.
  }
  return hits;
}

/**
 * Rank tools for disclosure. Order is based on a weighted sum of:
 *   - keyword relevance to the task (weight 3)
 *   - historical use count (weight 1, log-scaled)
 *   - recency (weight 1, decays across the past 30 days)
 *   - essential / pinned bonus (weight 10)
 *
 * @param {object[]} tools
 * @param {object} [context] - { task, usage, recent, essential }
 * @returns {object[]} Shallow copy sorted descending by score.
 */
export function rankToolsForDisclosure(tools, context = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const task = typeof context.task === "string" ? context.task : "";
  const keywords = tokenizeText(task);
  const usage = context.usage && typeof context.usage === "object" ? context.usage : {};
  const recent = context.recent && typeof context.recent === "object" ? context.recent : {};
  const essentialList = Array.isArray(context.essential) ? context.essential : [];
  const essentialSet = new Set(essentialList);
  const now = Date.now();

  const rows = tools.map((tool) => {
    const name = getToolName(tool);
    const rel = relevanceScore(tool, keywords);
    const uses = Number(usage[name]) || 0;
    const usageScore = uses > 0 ? Math.log10(uses + 1) : 0;
    const lastUsed = Number(recent[name]) || 0;
    const ageMs = lastUsed > 0 ? Math.max(0, now - lastUsed) : Number.POSITIVE_INFINITY;
    const recencyScore = lastUsed > 0 ? Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000)) : 0;
    const essentialBonus = essentialSet.has(name) ? 10 : 0;
    const score = rel * 3 + usageScore + recencyScore + essentialBonus;
    return {
      tool,
      name,
      score,
      relevance: rel,
      uses,
      recency: recencyScore,
      essential: essentialBonus > 0,
      tokens: estimateToolTokens(tool),
    };
  });

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Stable tiebreakers: fewer tokens first, then alphabetical.
    if (a.tokens !== b.tokens) return a.tokens - b.tokens;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Greedy selection: take ranked tools top-down until the budget is spent.
 *
 * @param {object[]} rankedTools - Output of `rankToolsForDisclosure`.
 * @param {number} budgetTokens
 * @returns {{selected: object[], excluded: object[], tokensUsed: number, tokensAvailable: number}}
 */
export function selectToolsWithinBudget(rankedTools, budgetTokens) {
  const available = Number.isFinite(budgetTokens) ? Math.max(0, budgetTokens) : 0;
  const selected = [];
  const excluded = [];
  let used = 0;
  if (!Array.isArray(rankedTools)) {
    return { selected, excluded, tokensUsed: 0, tokensAvailable: available };
  }
  for (const row of rankedTools) {
    const cost = Number(row?.tokens) || estimateToolTokens(row?.tool);
    if (used + cost <= available) {
      selected.push(row);
      used += cost;
    } else {
      excluded.push(row);
    }
  }
  return {
    selected,
    excluded,
    tokensUsed: used,
    tokensAvailable: available,
  };
}

// ─── High-level disclose helper ──────────────────────────────────────────────

/**
 * End-to-end disclosure:
 *   1. Load essential / pinned tools from storage (scoped by workspace).
 *   2. Rank candidates (pinned + caller-provided).
 *   3. Apply minRelevance / maxTools filters.
 *   4. Select within budget.
 *
 * @param {object[]} tools
 * @param {object} [context] - { task, usage, recent, workspaceId }
 * @param {object} [options] - { budget, maxTools, minRelevance, pinnedTools }
 * @returns {Promise<{tools: object[], summary: object, reasoning: string}>}
 */
export async function discloseTools(tools, context = {}, options = {}) {
  const toolsArr = Array.isArray(tools) ? tools : [];
  const budget = Number.isFinite(options.budget) ? Math.max(0, options.budget) : 2000;
  const maxTools = Number.isFinite(options.maxTools) ? Math.max(0, options.maxTools) : 0;
  const minRelevance = Number.isFinite(options.minRelevance) ? options.minRelevance : 0;
  const pinnedTools = Array.isArray(options.pinnedTools) ? options.pinnedTools : [];

  let essentialList = [];
  if (context.workspaceId !== undefined) {
    try {
      essentialList = await getEssentialTools(context.workspaceId);
    } catch {
      essentialList = [];
    }
  }
  const essentialSet = new Set([...essentialList, ...pinnedTools]);

  const ranked = rankToolsForDisclosure(toolsArr, {
    ...context,
    essential: [...essentialSet],
  });

  // Separate pinned/essential rows so they are always included first.
  const pinnedRows = [];
  const otherRows = [];
  for (const row of ranked) {
    if (essentialSet.has(row.name)) pinnedRows.push(row);
    else if (row.relevance >= minRelevance) otherRows.push(row);
  }

  // Include pinned tools unconditionally, even if they push the budget slightly.
  let pinnedTokens = 0;
  for (const row of pinnedRows) pinnedTokens += row.tokens;

  // Remaining budget for non-pinned rows.
  const remaining = Math.max(0, budget - pinnedTokens);
  const pool = maxTools > 0 ? otherRows.slice(0, Math.max(0, maxTools - pinnedRows.length)) : otherRows;
  const greedy = selectToolsWithinBudget(pool, remaining);

  const finalRows = [...pinnedRows, ...greedy.selected];
  const excludedRows = [
    ...otherRows.filter((r) => !greedy.selected.includes(r)),
  ];

  const finalTools = finalRows.map((r) => r.tool);
  const tokensUsed = pinnedTokens + greedy.tokensUsed;
  const summary = {
    totalCandidates: toolsArr.length,
    selectedCount: finalRows.length,
    excludedCount: excludedRows.length,
    pinnedCount: pinnedRows.length,
    tokensUsed,
    tokensAvailable: budget,
    tokensRemaining: Math.max(0, budget - tokensUsed),
  };
  const reasoning = buildReasoning(summary, pinnedRows, greedy, context);
  return { tools: finalTools, summary, reasoning };
}

function buildReasoning(summary, pinnedRows, greedy, context) {
  const parts = [];
  if (pinnedRows.length > 0) {
    parts.push(`${pinnedRows.length} essential tool(s) included unconditionally`);
  }
  parts.push(
    `${greedy.selected.length} additional tool(s) chosen within ${summary.tokensAvailable}-token budget`,
  );
  if (context && typeof context.task === "string" && context.task.trim()) {
    parts.push(`ranked by relevance to task: "${context.task.slice(0, 60)}"`);
  }
  if (summary.excludedCount > 0) {
    parts.push(`${summary.excludedCount} tool(s) excluded to fit budget`);
  }
  return parts.join("; ");
}

// ─── Tiering ─────────────────────────────────────────────────────────────────

/**
 * Partition tools into three tiers: essential (top ~10% by score),
 * commonly_used (mid 40%), and rarely_used (tail 50%).
 * Input may be raw tool defs OR ranked rows from `rankToolsForDisclosure`.
 *
 * @param {object[]} tools
 * @returns {{essential: object[], commonly_used: object[], rarely_used: object[]}}
 */
export function tierTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { essential: [], commonly_used: [], rarely_used: [] };
  }
  const ranked = tools[0] && typeof tools[0] === "object" && "score" in tools[0]
    ? tools
    : rankToolsForDisclosure(tools);
  const n = ranked.length;
  // Guarantee at least one essential entry when we have any tools.
  const essentialCount = Math.max(1, Math.floor(n * 0.1));
  const commonCount = Math.max(0, Math.floor(n * 0.4));
  const essential = ranked.slice(0, essentialCount).map((r) => r.tool);
  const commonly_used = ranked.slice(essentialCount, essentialCount + commonCount).map((r) => r.tool);
  const rarely_used = ranked.slice(essentialCount + commonCount).map((r) => r.tool);
  return { essential, commonly_used, rarely_used };
}

// ─── Essential tool pins (persistent) ────────────────────────────────────────

async function loadEssential(workspaceId) {
  const p = essentialPath(workspaceId);
  const data = await readJsonPath(p, { tools: [] });
  if (!data || !Array.isArray(data.tools)) return { tools: [] };
  return data;
}

async function saveEssential(workspaceId, data) {
  const p = essentialPath(workspaceId);
  await writeJsonPath(p, data);
}

/**
 * Mark a tool as essential (always included in disclosure).
 * Optionally scoped by workspace.
 *
 * @param {string} toolName
 * @param {string|null} [workspaceId=null]
 * @returns {Promise<string[]>} Updated essential list.
 */
export async function markEssential(toolName, workspaceId = null) {
  if (!toolName || typeof toolName !== "string") {
    throw new Error("toolName is required");
  }
  const p = essentialPath(workspaceId);
  return withPathLock(p, async () => {
    const data = await loadEssential(workspaceId);
    if (!data.tools.includes(toolName)) {
      data.tools.push(toolName);
      await saveEssential(workspaceId, data);
    }
    return [...data.tools];
  });
}

/**
 * Remove a tool from the essential list.
 *
 * @param {string} toolName
 * @param {string|null} [workspaceId=null]
 * @returns {Promise<string[]>}
 */
export async function unmarkEssential(toolName, workspaceId = null) {
  if (!toolName || typeof toolName !== "string") {
    throw new Error("toolName is required");
  }
  const p = essentialPath(workspaceId);
  return withPathLock(p, async () => {
    const data = await loadEssential(workspaceId);
    const idx = data.tools.indexOf(toolName);
    if (idx >= 0) {
      data.tools.splice(idx, 1);
      await saveEssential(workspaceId, data);
    }
    return [...data.tools];
  });
}

/**
 * List essential tools for a workspace.
 *
 * @param {string|null} [workspaceId=null]
 * @returns {Promise<string[]>}
 */
export async function getEssentialTools(workspaceId = null) {
  const data = await loadEssential(workspaceId);
  return [...data.tools];
}

// ─── Context budget ──────────────────────────────────────────────────────────

/**
 * Compute how many tokens remain in a model's context after existing messages.
 * Used by disclose() to decide how much room is left for tool descriptions.
 *
 * @param {object[]} conversation - Array of messages (role + content).
 * @param {number} modelMaxTokens
 * @returns {number} Remaining tokens (>= 0).
 */
export function computeContextBudget(conversation, modelMaxTokens) {
  const max = Number.isFinite(modelMaxTokens) ? Math.max(0, modelMaxTokens) : 0;
  if (!Array.isArray(conversation) || conversation.length === 0) return max;
  let used = 0;
  for (const msg of conversation) {
    if (!msg || typeof msg !== "object") continue;
    // Skip entries that have no real message shape — they should not consume budget.
    if (!("content" in msg) && !("tool_calls" in msg)) continue;
    const content = typeof msg.content === "string" ? msg.content : "";
    // "~4 chars per token" + 4 tokens per message overhead.
    used += Math.ceil(content.length / 4) + 4;
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        try {
          used += Math.ceil(JSON.stringify(call).length / 4) + 2;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return Math.max(0, max - used);
}

// ─── Disclosure learning ─────────────────────────────────────────────────────

async function loadStats(workspaceId) {
  const p = statsPath(workspaceId);
  const data = await readJsonPath(p, { disclosures: [], counts: {}, taskCounts: {} });
  if (!data || typeof data !== "object") {
    return { disclosures: [], counts: {}, taskCounts: {} };
  }
  if (!Array.isArray(data.disclosures)) data.disclosures = [];
  if (!data.counts || typeof data.counts !== "object") data.counts = {};
  if (!data.taskCounts || typeof data.taskCounts !== "object") data.taskCounts = {};
  return data;
}

async function saveStats(workspaceId, data) {
  const p = statsPath(workspaceId);
  await writeJsonPath(p, data);
}

/**
 * Record which tools were disclosed for a given task type. Used to learn
 * which tools are worth pinning.
 *
 * @param {string|null} workspaceId
 * @param {string[]} toolNames
 * @param {string} [taskType="general"]
 * @returns {Promise<void>}
 */
export async function recordDisclosure(workspaceId, toolNames, taskType = "general") {
  if (!Array.isArray(toolNames)) return;
  const names = toolNames.filter((n) => typeof n === "string" && n.length > 0);
  if (names.length === 0) return;
  const p = statsPath(workspaceId);
  await withPathLock(p, async () => {
    const data = await loadStats(workspaceId);
    const now = new Date().toISOString();
    data.disclosures.push({ timestamp: now, taskType, tools: names });
    // Cap history to avoid unbounded growth.
    if (data.disclosures.length > 1000) {
      data.disclosures = data.disclosures.slice(-1000);
    }
    for (const name of names) {
      data.counts[name] = (Number(data.counts[name]) || 0) + 1;
      if (!data.taskCounts[taskType]) data.taskCounts[taskType] = {};
      data.taskCounts[taskType][name] = (Number(data.taskCounts[taskType][name]) || 0) + 1;
    }
    await saveStats(workspaceId, data);
  });
}

/**
 * Aggregate stats for disclosure decisions.
 *
 * @param {string|null} [workspaceId=null]
 * @returns {Promise<object>}
 */
export async function getDisclosureStats(workspaceId = null) {
  const data = await loadStats(workspaceId);
  const entries = Object.entries(data.counts).map(([tool, count]) => ({
    tool,
    count: Number(count) || 0,
  }));
  entries.sort((a, b) => b.count - a.count);
  return {
    totalDisclosures: data.disclosures.length,
    uniqueTools: entries.length,
    topTools: entries.slice(0, 20),
    taskTypes: Object.keys(data.taskCounts),
  };
}

/**
 * Suggest tools to pin based on disclosure frequency. Tools that appear in
 * more than 30% of disclosures are considered good candidates.
 *
 * @param {string|null} [workspaceId=null]
 * @returns {Promise<{tool: string, count: number, frequency: number}[]>}
 */
export async function suggestPinning(workspaceId = null) {
  const data = await loadStats(workspaceId);
  const total = data.disclosures.length;
  if (total === 0) return [];
  const suggestions = [];
  for (const [tool, count] of Object.entries(data.counts)) {
    const c = Number(count) || 0;
    const frequency = c / total;
    if (frequency >= 0.3) {
      suggestions.push({ tool, count: c, frequency });
    }
  }
  suggestions.sort((a, b) => b.frequency - a.frequency);
  return suggestions;
}
