// @ts-check
/**
 * Phase 32.3: Tool discovery.
 *
 * Tracks tool effectiveness by task type and learns which tools to recommend
 * for future similar tasks. Task types are inferred from user descriptions
 * via keyword pattern matching.
 *
 * @module tool-discovery
 */

/**
 * Keyword-based task type classification patterns.
 * Order matters only for tie-breaking in {@link classifyTaskType}.
 */
const TASK_TYPE_PATTERNS = {
  search: /\b(search|find|look\s?up|query)\b/i,
  create: /\b(create|add|new|make)\b/i,
  analyze: /\b(analyze|examine|inspect|review)\b/i,
  modify: /\b(update|edit|modify|change)\b/i,
  delete: /\b(delete|remove|destroy)\b/i,
  execute: /\b(run|execute|deploy|build)\b/i,
  summarize: /\b(summarize|summary|overview)\b/i,
  explain: /\b(explain|describe|what\s+is)\b/i,
};

/**
 * Classify a natural-language task description into a known task type.
 * Returns `{ type: "general", confidence: 0 }` when nothing matches.
 *
 * @param {string} description
 * @returns {{ type: string; confidence: number }}
 */
export function classifyTaskType(description) {
  if (typeof description !== "string" || !description.trim()) {
    return { type: "general", confidence: 0 };
  }
  const text = description.trim();
  /** @type {Array<{ type: string; matchLen: number }>} */
  const hits = [];
  for (const [type, rx] of Object.entries(TASK_TYPE_PATTERNS)) {
    const m = text.match(rx);
    if (m) hits.push({ type, matchLen: m[0].length });
  }
  if (hits.length === 0) return { type: "general", confidence: 0 };
  // Prefer the longest literal match, then first-defined order.
  hits.sort((a, b) => b.matchLen - a.matchLen);
  const top = hits[0];
  // Confidence scales with number of matches (more matches → more certain)
  // but is capped at 1.
  const confidence = Math.min(1, 0.5 + (hits.length - 1) * 0.15 + top.matchLen / 40);
  return { type: top.type, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * @typedef {Object} ToolUsageContext
 * @property {string=} taskType
 * @property {boolean=} success
 * @property {number=} durationMs
 * @property {number=} resultSize
 * @property {number=} userRating  1-5
 */

/**
 * @typedef {Object} ToolRecord
 * @property {number} uses
 * @property {number} successes
 * @property {number} totalDurationMs
 * @property {number} ratingSum
 * @property {number} ratingCount
 * @property {Record<string, { uses: number; successes: number; totalDurationMs: number }>} byTaskType
 */

/**
 * Create an isolated tool discovery tracker.
 *
 * @returns {{
 *   recordToolUsage: (toolName: string, context?: ToolUsageContext) => void;
 *   getToolStats: (toolName: string) => object | null;
 *   getAllStats: () => Record<string, object>;
 *   getToolEffectivenessByTask: (taskType: string) => Array<object>;
 *   recommendToolsForTask: (taskDescription: string) => Array<{ tool: string; reason: string; confidence: number }>;
 *   getGlobalRanking: () => Array<object>;
 *   exportLearning: () => { version: number; tools: Record<string, ToolRecord> };
 *   importLearning: (data: { version?: number; tools?: Record<string, ToolRecord> }) => void;
 *   reset: () => void;
 * }}
 */
export function createToolDiscovery() {
  /** @type {Map<string, ToolRecord>} */
  const tools = new Map();

  function ensure(toolName) {
    let rec = tools.get(toolName);
    if (!rec) {
      rec = {
        uses: 0,
        successes: 0,
        totalDurationMs: 0,
        ratingSum: 0,
        ratingCount: 0,
        byTaskType: {},
      };
      tools.set(toolName, rec);
    }
    return rec;
  }

  function recordToolUsage(toolName, context = {}) {
    if (typeof toolName !== "string" || !toolName) return;
    const rec = ensure(toolName);
    rec.uses += 1;
    const success = context.success !== false; // default to true
    if (success) rec.successes += 1;
    const durationMs = Number(context.durationMs);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      rec.totalDurationMs += durationMs;
    }
    const rating = Number(context.userRating);
    if (Number.isFinite(rating) && rating >= 1 && rating <= 5) {
      rec.ratingSum += rating;
      rec.ratingCount += 1;
    }
    const taskType = typeof context.taskType === "string" && context.taskType.trim()
      ? context.taskType.trim()
      : null;
    if (taskType) {
      if (!rec.byTaskType[taskType]) {
        rec.byTaskType[taskType] = { uses: 0, successes: 0, totalDurationMs: 0 };
      }
      const tt = rec.byTaskType[taskType];
      tt.uses += 1;
      if (success) tt.successes += 1;
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        tt.totalDurationMs += durationMs;
      }
    }
  }

  function summarize(rec) {
    const successRate = rec.uses > 0 ? rec.successes / rec.uses : 0;
    const avgDuration = rec.uses > 0 ? rec.totalDurationMs / rec.uses : 0;
    const avgRating = rec.ratingCount > 0 ? rec.ratingSum / rec.ratingCount : null;
    const topTaskTypes = Object.entries(rec.byTaskType)
      .map(([type, tt]) => ({
        type,
        uses: tt.uses,
        successRate: tt.uses > 0 ? tt.successes / tt.uses : 0,
      }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, 5);
    return {
      uses: rec.uses,
      successes: rec.successes,
      successRate: Math.round(successRate * 1000) / 1000,
      avgDuration: Math.round(avgDuration * 100) / 100,
      avgRating,
      topTaskTypes,
    };
  }

  function getToolStats(toolName) {
    const rec = tools.get(toolName);
    if (!rec) return null;
    return { tool: toolName, ...summarize(rec) };
  }

  function getAllStats() {
    /** @type {Record<string, object>} */
    const out = {};
    for (const [name, rec] of tools.entries()) {
      out[name] = summarize(rec);
    }
    return out;
  }

  function getToolEffectivenessByTask(taskType) {
    if (typeof taskType !== "string" || !taskType.trim()) return [];
    const key = taskType.trim();
    const rows = [];
    for (const [name, rec] of tools.entries()) {
      const tt = rec.byTaskType[key];
      if (!tt || tt.uses === 0) continue;
      const successRate = tt.successes / tt.uses;
      const avgDuration = tt.totalDurationMs / tt.uses;
      // Score: success-weighted with log-scaled volume, penalized by latency.
      // normalizedDuration: 1 for very fast tools, shrinks for slow ones.
      const normalizedDuration = 1 + Math.log10(Math.max(1, avgDuration) / 10);
      const score = (successRate * Math.log(tt.uses + 1)) / Math.max(0.5, normalizedDuration);
      rows.push({
        tool: name,
        score: Math.round(score * 1000) / 1000,
        successRate: Math.round(successRate * 1000) / 1000,
        uses: tt.uses,
        avgDuration: Math.round(avgDuration * 100) / 100,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  function recommendToolsForTask(taskDescription) {
    const { type, confidence } = classifyTaskType(taskDescription || "");
    // If we can identify a task type, prefer tools proven in that type.
    const typed = type !== "general" ? getToolEffectivenessByTask(type) : [];
    if (typed.length > 0) {
      return typed.slice(0, 5).map((row) => ({
        tool: row.tool,
        reason: `Effective for ${type} tasks (${row.uses} uses, ${(row.successRate * 100).toFixed(0)}% success)`,
        confidence: Math.round(Math.min(1, confidence * 0.5 + row.successRate * 0.5) * 100) / 100,
      }));
    }
    // Fallback: use global ranking when no task-type history exists.
    const ranking = getGlobalRanking().slice(0, 5);
    return ranking.map((row) => ({
      tool: row.tool,
      reason: `Top-ranked globally (${row.uses} uses, ${(row.successRate * 100).toFixed(0)}% success)`,
      confidence: Math.round(row.successRate * 100) / 100,
    }));
  }

  function getGlobalRanking() {
    const rows = [];
    for (const [name, rec] of tools.entries()) {
      if (rec.uses === 0) continue;
      const successRate = rec.successes / rec.uses;
      const avgDuration = rec.totalDurationMs / rec.uses;
      const normalizedDuration = 1 + Math.log10(Math.max(1, avgDuration) / 10);
      // Score = successRate * log(uses + 1) / normalizedDuration
      const score = (successRate * Math.log(rec.uses + 1)) / Math.max(0.5, normalizedDuration);
      rows.push({
        tool: name,
        score: Math.round(score * 1000) / 1000,
        successRate: Math.round(successRate * 1000) / 1000,
        uses: rec.uses,
        avgDuration: Math.round(avgDuration * 100) / 100,
      });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
  }

  function exportLearning() {
    /** @type {Record<string, ToolRecord>} */
    const dumped = {};
    for (const [name, rec] of tools.entries()) {
      dumped[name] = {
        uses: rec.uses,
        successes: rec.successes,
        totalDurationMs: rec.totalDurationMs,
        ratingSum: rec.ratingSum,
        ratingCount: rec.ratingCount,
        byTaskType: JSON.parse(JSON.stringify(rec.byTaskType)),
      };
    }
    return { version: 1, tools: dumped };
  }

  function importLearning(data) {
    if (!data || typeof data !== "object") return;
    const payload = data.tools && typeof data.tools === "object" ? data.tools : {};
    for (const [name, raw] of Object.entries(payload)) {
      if (!raw || typeof raw !== "object") continue;
      const rec = ensure(name);
      rec.uses = Number(raw.uses) || 0;
      rec.successes = Number(raw.successes) || 0;
      rec.totalDurationMs = Number(raw.totalDurationMs) || 0;
      rec.ratingSum = Number(raw.ratingSum) || 0;
      rec.ratingCount = Number(raw.ratingCount) || 0;
      rec.byTaskType = {};
      const byType = raw.byTaskType && typeof raw.byTaskType === "object" ? raw.byTaskType : {};
      for (const [t, tt] of Object.entries(byType)) {
        if (!tt || typeof tt !== "object") continue;
        rec.byTaskType[t] = {
          uses: Number(tt.uses) || 0,
          successes: Number(tt.successes) || 0,
          totalDurationMs: Number(tt.totalDurationMs) || 0,
        };
      }
    }
  }

  function reset() {
    tools.clear();
  }

  return {
    recordToolUsage,
    getToolStats,
    getAllStats,
    getToolEffectivenessByTask,
    recommendToolsForTask,
    getGlobalRanking,
    exportLearning,
    importLearning,
    reset,
  };
}

/** Singleton used by the agent loop and HTTP routes. */
export const globalToolDiscovery = createToolDiscovery();
