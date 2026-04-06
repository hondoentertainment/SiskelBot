/**
 * Phase 20: Agent memory context injection.
 * Retrieves relevant memories and formats them as a system prompt section
 * for injection into the agent loop before the LLM call.
 */
import { listMemories, recall } from "./agent-memory.js";

const MAX_MEMORY_TOKENS = 1000;
// Rough estimate: 1 token ~ 4 chars
const MAX_MEMORY_CHARS = MAX_MEMORY_TOKENS * 4;
const RECENT_MEMORIES_LIMIT = 20;

/**
 * Build a memory context section for system prompt injection.
 * 1. Get recent memories (last 20)
 * 2. Search memories relevant to the current conversation
 * 3. Format as a system prompt section
 * 4. Respect token budget (max 1000 tokens of memory context)
 *
 * @param {string} userId
 * @param {string} workspaceId
 * @param {Array<{ role: string, content: string }>} currentMessages
 * @returns {Promise<string>} Formatted memory context or empty string
 */
export async function getMemoryContext(userId, workspaceId, currentMessages) {
  if (!userId || !workspaceId) return "";

  try {
    // 1. Get recent memories
    const recent = await listMemories(userId, workspaceId, {
      limit: RECENT_MEMORIES_LIMIT,
      sortBy: "createdAt",
    });

    if (recent.total === 0) return "";

    // 2. Extract a search query from the last user messages
    const relevantMemories = await getRelevantMemories(userId, workspaceId, currentMessages);

    // 3. Merge and deduplicate
    const seen = new Set();
    const combined = [];

    // Prioritize relevant memories first
    for (const m of relevantMemories) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        combined.push(m);
      }
    }
    // Then add recent memories
    for (const m of recent.memories) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        combined.push(m);
      }
    }

    if (combined.length === 0) return "";

    // 4. Format with token budget
    return formatMemorySection(combined);
  } catch {
    // Memory injection is best-effort; don't break the agent loop
    return "";
  }
}

/**
 * Search memories relevant to the current conversation.
 */
async function getRelevantMemories(userId, workspaceId, messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  // Extract query from last few user messages
  const userMessages = messages
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .slice(-3);

  if (userMessages.length === 0) return [];

  const query = userMessages.map((m) => m.content).join(" ").slice(0, 500);
  const result = await recall(userId, workspaceId, query, { limit: 10 });
  return result.memories;
}

/**
 * Format memories into a system prompt section within the token budget.
 */
function formatMemorySection(memories) {
  const lines = ["## Agent Memory", "You remember these facts about the user and workspace:"];
  let charCount = lines.join("\n").length;

  // Group by category
  const grouped = {};
  for (const m of memories) {
    const cat = m.category || "fact";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(m);
  }

  const categoryOrder = ["instruction", "preference", "fact", "context", "observation"];
  for (const cat of categoryOrder) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;

    const header = `\n### ${cat.charAt(0).toUpperCase() + cat.slice(1)}s`;
    if (charCount + header.length > MAX_MEMORY_CHARS) break;
    lines.push(header);
    charCount += header.length;

    for (const m of items) {
      const line = `- ${m.content}`;
      if (charCount + line.length + 1 > MAX_MEMORY_CHARS) break;
      lines.push(line);
      charCount += line.length + 1;
    }
  }

  const result = lines.join("\n");
  return result.length > lines[0].length + lines[1].length + 2 ? result : "";
}
