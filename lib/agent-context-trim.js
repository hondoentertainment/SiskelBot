/**
 * Cap tool result payload size in the agent loop to avoid unbounded context growth.
 * Set AGENT_TOOL_RESULT_MAX_CHARS > 0 to enable (0 = disabled).
 */

const SUFFIX = "\n...(truncated by server; increase AGENT_TOOL_RESULT_MAX_CHARS)";

/**
 * @param {string} content
 * @param {number} maxChars - 0 means no truncation
 * @returns {string}
 */
export function truncateToolResultContent(content, maxChars) {
  const n = Math.floor(Number(maxChars));
  if (!Number.isFinite(n) || n <= 0) return typeof content === "string" ? content : String(content ?? "");
  const s = typeof content === "string" ? content : String(content ?? "");
  if (s.length <= n) return s;
  const budget = Math.max(64, n - SUFFIX.length);
  return s.slice(0, budget) + SUFFIX;
}

/**
 * @returns {number}
 */
export function getAgentToolResultMaxChars() {
  const v = Number(process.env.AGENT_TOOL_RESULT_MAX_CHARS);
  return Number.isFinite(v) && v > 0 ? Math.min(2_000_000, Math.floor(v)) : 0;
}
