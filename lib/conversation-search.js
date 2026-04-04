/**
 * Full-text search across conversation messages with snippet extraction.
 */
import * as storage from "./storage.js";

/**
 * Search conversations by message content with optional date filtering.
 * @param {string} query - Search query string
 * @param {string} [userId="anonymous"]
 * @param {string} [workspaceId="default"]
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @param {number} [options.offset=0]
 * @param {string} [options.dateFrom] - ISO date string lower bound
 * @param {string} [options.dateTo] - ISO date string upper bound
 * @returns {Promise<{results: object[], total: number}>}
 */
export async function searchConversations(query, userId = "anonymous", workspaceId = "default", options = {}) {
  const { limit = 20, offset = 0, dateFrom, dateTo } = options;

  if (!query || typeof query !== "string" || !query.trim()) {
    return { results: [], total: 0 };
  }

  const conversations = await storage.list("conversations", workspaceId, userId);
  const queryLower = query.trim().toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);
  const matches = [];

  for (const conv of conversations) {
    if (conv._isBranch) continue;

    const createdAt = conv.createdAt ? new Date(conv.createdAt) : null;
    if (dateFrom && createdAt && createdAt < new Date(dateFrom)) continue;
    if (dateTo && createdAt && createdAt > new Date(dateTo)) continue;

    const messages = Array.isArray(conv.messages) ? conv.messages : [];
    const titleLower = (conv.title || "").toLowerCase();
    const titleMatch = queryTerms.every((t) => titleLower.includes(t));

    let bestSnippet = null;
    let bestScore = 0;

    for (const msg of messages) {
      const content = String(msg.content || "");
      const contentLower = content.toLowerCase();
      const termMatches = queryTerms.filter((t) => contentLower.includes(t)).length;
      if (termMatches === 0) continue;

      const score = termMatches / queryTerms.length;
      if (score > bestScore) {
        bestScore = score;
        bestSnippet = extractSnippet(content, queryTerms);
      }
    }

    if (titleMatch && !bestSnippet) {
      bestSnippet = conv.title || "";
      bestScore = Math.max(bestScore, 0.5);
    }

    if (bestScore > 0) {
      matches.push({
        conversationId: conv.id,
        title: conv.title || "Untitled",
        matchSnippet: bestSnippet,
        timestamp: conv.createdAt || null,
        score: bestScore,
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);

  return {
    results: matches.slice(offset, offset + limit),
    total: matches.length,
  };
}

function extractSnippet(content, queryTerms, contextChars = 80) {
  const contentLower = content.toLowerCase();
  let bestPos = -1;

  for (const term of queryTerms) {
    const idx = contentLower.indexOf(term);
    if (idx >= 0) {
      bestPos = idx;
      break;
    }
  }

  if (bestPos < 0) return content.slice(0, contextChars * 2);

  const start = Math.max(0, bestPos - contextChars);
  const end = Math.min(content.length, bestPos + contextChars);
  let snippet = content.slice(start, end).trim();
  if (start > 0) snippet = "..." + snippet;
  if (end < content.length) snippet = snippet + "...";

  return snippet;
}
