/**
 * Phase 20: Agent memory context injection.
 * Retrieves relevant memories, scores them by keyword overlap + recency + importance,
 * and injects a ranked subset into the agent's message array as a system message.
 */
import { listMemories } from "./agent-memory.js";

const DEFAULT_MAX_MEMORIES = 10;
const DEFAULT_MAX_TOKENS = 1000;
// Rough estimate: 1 token ~ 4 chars
const CHARS_PER_TOKEN = 4;

// Words shorter than this are ignored for keyword matching (stop words, articles, etc.)
const MIN_KEYWORD_LENGTH = 3;

/**
 * Extract meaningful keywords from a string, lowercased and deduplicated.
 * Filters out very short words that are unlikely to be meaningful.
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  if (!text || typeof text !== "string") return [];
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= MIN_KEYWORD_LENGTH)
  )];
}

/**
 * Score a single memory against a user message for relevance.
 *
 * Scoring formula:
 *   combined = 0.5 * keyword + 0.3 * recency + 0.2 * importance
 *
 * - keyword: fraction of user-message keywords that appear in the memory content (0-1)
 * - recency: 1 / (1 + daysSinceCreated), where daysSinceCreated is computed from now (0-1)
 * - importance: (memory.importance - 1) / 4, mapping 1-5 to 0-1
 *
 * @param {{ content: string, importance?: number, createdAt?: string }} memory
 * @param {string} userMessage - the latest user message text
 * @param {Date} [now] - override for testability; defaults to new Date()
 * @returns {{ keyword: number, recency: number, importance: number, combined: number }}
 */
export function scoreMemory(memory, userMessage, now) {
  const refDate = now || new Date();

  // -- Keyword overlap --
  const msgKeywords = extractKeywords(userMessage);
  let keywordScore = 0;
  if (msgKeywords.length > 0) {
    const memText = (memory.content || "").toLowerCase();
    let hits = 0;
    for (const kw of msgKeywords) {
      if (memText.includes(kw)) hits++;
    }
    keywordScore = hits / msgKeywords.length;
  }

  // -- Recency --
  let recencyScore = 0.5; // default if no date
  if (memory.createdAt) {
    const createdMs = new Date(memory.createdAt).getTime();
    const nowMs = refDate.getTime();
    const daysSince = Math.max(0, (nowMs - createdMs) / (1000 * 60 * 60 * 24));
    recencyScore = 1 / (1 + daysSince);
  }

  // -- Importance --
  const imp = typeof memory.importance === "number" ? memory.importance : 3;
  const clamped = Math.max(1, Math.min(5, imp));
  const importanceScore = (clamped - 1) / 4; // maps 1->0, 5->1

  // -- Combined --
  const combined = 0.5 * keywordScore + 0.3 * recencyScore + 0.2 * importanceScore;

  return {
    keyword: keywordScore,
    recency: recencyScore,
    importance: importanceScore,
    combined,
  };
}

/**
 * Build the markdown injection block from a list of memories.
 *
 * @param {Array<{ content: string, category?: string, importance?: number }>} memories
 * @returns {string}
 */
export function buildMemoryBlock(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return "";

  const lines = [
    "## Workspace Memory",
    "The following are remembered facts about this workspace and user:",
  ];

  for (const m of memories) {
    const cat = m.category || "fact";
    const imp = typeof m.importance === "number" ? m.importance : 3;
    lines.push(`- [${cat}] ${m.content} (importance: ${imp})`);
  }

  return lines.join("\n");
}

/**
 * Inject relevant memories into an agent message array.
 *
 * Retrieves all memories for the user+workspace, scores each one against the
 * latest user message, selects the top-K within a token budget, and inserts a
 * system message containing the memory block AFTER the first system message
 * but BEFORE the first user message. If no system message exists, it prepends
 * the memory block as a new system message.
 *
 * @param {{
 *   messages: Array<{ role: string, content: string }>,
 *   workspace: string,
 *   userId: string,
 *   maxMemories?: number,
 *   maxTokens?: number,
 *   _listMemoriesFn?: function,
 * }} params
 * @returns {Promise<{
 *   messages: Array<{ role: string, content: string }>,
 *   injectedCount: number,
 *   totalMemories: number,
 *   topScore: number,
 * }>}
 */
export async function injectMemories({
  messages,
  workspace,
  userId,
  maxMemories = DEFAULT_MAX_MEMORIES,
  maxTokens = DEFAULT_MAX_TOKENS,
  _listMemoriesFn,
}) {
  const empty = { messages, injectedCount: 0, totalMemories: 0, topScore: 0 };

  try {
    if (!Array.isArray(messages) || !userId || !workspace) {
      return empty;
    }

    // 1. Retrieve all memories
    const listFn = typeof _listMemoriesFn === "function" ? _listMemoriesFn : listMemories;
    const result = await listFn(userId, workspace, { limit: 200 });
    const allMemories = result.memories || [];

    if (allMemories.length === 0) {
      return { messages, injectedCount: 0, totalMemories: 0, topScore: 0 };
    }

    // 2. Find the latest user message for keyword scoring
    const lastUserMsg = [...messages]
      .reverse()
      .find((m) => m.role === "user" && typeof m.content === "string");
    const userText = lastUserMsg?.content || "";

    // 3. Score and rank
    const scored = allMemories.map((mem) => ({
      ...mem,
      _scores: scoreMemory(mem, userText),
    }));
    scored.sort((a, b) => b._scores.combined - a._scores.combined);

    // 4. Take top-K
    let selected = scored.slice(0, Math.max(1, maxMemories));

    // 5. Trim by token budget
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    let charCount = 0;
    const budgeted = [];
    for (const mem of selected) {
      const lineLen = `- [${mem.category || "fact"}] ${mem.content} (importance: ${mem.importance || 3})`.length + 1;
      if (charCount + lineLen > maxChars && budgeted.length > 0) break;
      charCount += lineLen;
      budgeted.push(mem);
    }
    selected = budgeted;

    if (selected.length === 0) {
      return { messages, injectedCount: 0, totalMemories: allMemories.length, topScore: scored[0]?._scores.combined || 0 };
    }

    // 6. Build injection block
    const block = buildMemoryBlock(selected);
    if (!block) {
      return { messages, injectedCount: 0, totalMemories: allMemories.length, topScore: 0 };
    }

    // 7. Find injection position: after last system message, before first user message
    const newMessages = [...messages];
    let insertIdx = 0;

    // Find the index right after the last consecutive system message at the start
    for (let i = 0; i < newMessages.length; i++) {
      if (newMessages[i].role === "system") {
        insertIdx = i + 1;
      } else {
        break;
      }
    }

    newMessages.splice(insertIdx, 0, {
      role: "system",
      content: block,
    });

    const topScore = scored[0]?._scores.combined || 0;

    return {
      messages: newMessages,
      injectedCount: selected.length,
      totalMemories: allMemories.length,
      topScore,
    };
  } catch {
    // Memory injection is best-effort; never fail the agent loop
    return empty;
  }
}
