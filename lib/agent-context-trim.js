/**
 * Cap tool result payload size in the agent loop to avoid unbounded context growth.
 * Set AGENT_TOOL_RESULT_MAX_CHARS > 0 to enable (0 = disabled).
 * Phase: drop oldest tool rounds when AGENT_TOOL_HISTORY_MAX_MESSAGES or AGENT_TOOL_HISTORY_MAX_CHARS exceeded.
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

/**
 * @returns {number} max tool *messages* to keep across the conversation (0 = unlimited)
 */
export function getAgentToolHistoryMaxMessages() {
  const v = Number(process.env.AGENT_TOOL_HISTORY_MAX_MESSAGES);
  return Number.isFinite(v) && v > 0 ? Math.min(500, Math.floor(v)) : 0;
}

/**
 * @returns {number} max total characters across all tool message contents (0 = unlimited)
 */
export function getAgentToolHistoryMaxChars() {
  const v = Number(process.env.AGENT_TOOL_HISTORY_MAX_CHARS);
  return Number.isFinite(v) && v > 0 ? Math.min(4_000_000, Math.floor(v)) : 0;
}

/**
 * Split messages into ordered segments: plain messages vs assistant+tool_calls+tool replies.
 * @param {object[]} messages
 * @returns {Array<{ type: 'simple'; msg: object } | { type: 'tool_round'; assistant: object; tools: object[] }>}
 */
function segmentMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const segments = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const assistant = m;
      i++;
      const tools = [];
      while (i < messages.length && messages[i]?.role === "tool") {
        tools.push(messages[i]);
        i++;
      }
      segments.push({ type: "tool_round", assistant, tools });
    } else {
      segments.push({ type: "simple", msg: m });
      i++;
    }
  }
  return segments;
}

function flattenSegments(segments) {
  const out = [];
  for (const s of segments) {
    if (s.type === "simple") out.push(s.msg);
    else {
      out.push(s.assistant, ...s.tools);
    }
  }
  return out;
}

function toolRoundStats(segments) {
  const rounds = segments.filter((s) => s.type === "tool_round");
  let toolCount = 0;
  let charSum = 0;
  for (const r of rounds) {
    for (const t of r.tools) {
      toolCount++;
      charSum += String(t?.content ?? "").length;
    }
  }
  return { rounds, toolCount, charSum };
}

/**
 * Remove oldest tool rounds until within message count and/or character budgets.
 * @param {object[]} messages
 * @param {number} maxToolMessages
 * @param {number} maxToolChars
 * @returns {object[]}
 */
export function applyToolMessageBudget(messages, maxToolMessages, maxToolChars) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const maxM = Math.max(0, Math.floor(Number(maxToolMessages) || 0));
  const maxC = Math.max(0, Math.floor(Number(maxToolChars) || 0));
  if (maxM <= 0 && maxC <= 0) return messages;

  const segments = segmentMessages(messages);
  let { toolCount, charSum } = toolRoundStats(segments);

  while ((maxM > 0 && toolCount > maxM) || (maxC > 0 && charSum > maxC)) {
    const idx = segments.findIndex((s) => s.type === "tool_round");
    if (idx < 0) break;
    const removed = /** @type {{ type: 'tool_round'; assistant: object; tools: object[] }} */ (segments[idx]);
    for (const t of removed.tools) {
      toolCount--;
      charSum -= String(t?.content ?? "").length;
    }
    segments.splice(idx, 1);
  }

  return flattenSegments(segments);
}
