/**
 * Full-text search across conversation messages using an inverted index.
 * Falls back to linear scan only when the index is not yet built.
 */
import * as storage from "./storage.js";
import { createSearchIndex, saveIndex, loadIndex, extractSnippet } from "./search-index.js";
import { join } from "path";

const INDEX_FILE = join(process.env.STORAGE_PATH || join(process.cwd(), "data"), "search-index.json");

/** Shared search index instance. */
const index = createSearchIndex();
let indexReady = false;

/**
 * Build the index from all existing conversations.
 * @param {string} [userId="anonymous"]
 * @param {string} [workspaceId="default"]
 */
export async function buildIndex(userId = "anonymous", workspaceId = "default") {
  const conversations = await storage.list("conversations", workspaceId, userId);
  for (const conv of conversations) {
    if (conv._isBranch) continue;
    indexConversation(conv);
  }
  indexReady = true;
  await persistIndex();
}

/**
 * Load a previously persisted index from disk.
 * @returns {Promise<boolean>}
 */
export async function loadPersistedIndex() {
  const loaded = await loadIndex(index, INDEX_FILE);
  if (loaded) indexReady = true;
  return loaded;
}

/**
 * Persist the current index to disk.
 */
export async function persistIndex() {
  try {
    await saveIndex(index, INDEX_FILE);
  } catch (e) {
    console.warn("[conversation-search] Failed to persist index:", e.message);
  }
}

/**
 * Add or update a conversation in the index.
 * @param {object} conversation
 */
export function indexConversation(conversation) {
  if (!conversation || !conversation.id) return;
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const parts = [conversation.title || ""];
  for (const msg of messages) {
    if (msg.content) parts.push(String(msg.content));
  }
  const text = parts.join(" ");
  index.add(`conv:${conversation.id}`, text, {
    type: "conversation",
    conversationId: conversation.id,
    title: conversation.title || "Untitled",
    timestamp: conversation.createdAt || null,
  });
}

/**
 * Remove a conversation from the index.
 * @param {string} conversationId
 */
export function removeConversation(conversationId) {
  index.remove(`conv:${conversationId}`);
}

/**
 * Add a knowledge document to the index.
 * @param {object} doc - { id, title, content }
 */
export function indexKnowledgeDoc(doc) {
  if (!doc || !doc.id) return;
  const text = [doc.title || "", doc.content || ""].join(" ");
  index.add(`know:${doc.id}`, text, {
    type: "knowledge",
    docId: doc.id,
    title: doc.title || "Untitled",
    createdAt: doc.createdAt || null,
  });
}

/**
 * Remove a knowledge document from the index.
 * @param {string} docId
 */
export function removeKnowledgeDoc(docId) {
  index.remove(`know:${docId}`);
}

/**
 * Rebuild the full index from scratch. Clears existing data.
 * @param {string} [userId="anonymous"]
 * @param {string} [workspaceId="default"]
 * @param {object[]} [knowledgeDocs] - Array of knowledge docs to index
 */
export async function reindex(userId = "anonymous", workspaceId = "default", knowledgeDocs = []) {
  index.clear();

  // Index conversations
  const conversations = await storage.list("conversations", workspaceId, userId);
  for (const conv of conversations) {
    if (conv._isBranch) continue;
    indexConversation(conv);
  }

  // Index knowledge documents
  for (const doc of knowledgeDocs) {
    indexKnowledgeDoc(doc);
  }

  indexReady = true;
  await persistIndex();
  return { indexed: index.size() };
}

/**
 * Search conversations by message content with optional date filtering.
 * Uses the inverted index when available, falls back to linear scan.
 * @param {string} query - Search query string
 * @param {string} [userId="anonymous"]
 * @param {string} [workspaceId="default"]
 * @param {object} [options]
 * @param {number} [options.limit=20]
 * @param {number} [options.offset=0]
 * @param {string} [options.dateFrom] - ISO date string lower bound
 * @param {string} [options.dateTo] - ISO date string upper bound
 * @param {string} [options.type] - "conversations", "knowledge", or "all"
 * @returns {Promise<{results: object[], total: number}>}
 */
export async function searchConversations(query, userId = "anonymous", workspaceId = "default", options = {}) {
  const { limit = 20, offset = 0, dateFrom, dateTo, type = "all" } = options;

  if (!query || typeof query !== "string" || !query.trim()) {
    return { results: [], total: 0 };
  }

  // If index is ready, use it
  if (indexReady) {
    return searchWithIndex(query, { limit, offset, dateFrom, dateTo, type });
  }

  // Fallback: linear scan for conversations only
  return linearScan(query, userId, workspaceId, { limit, offset, dateFrom, dateTo });
}

/**
 * Unified search across the inverted index.
 */
function searchWithIndex(query, options) {
  const { limit, offset, dateFrom, dateTo, type } = options;

  let indexType;
  if (type === "conversations") indexType = "conversation";
  else if (type === "knowledge") indexType = "knowledge";
  // else "all" — no type filter

  // Search with a large internal limit so we can apply date filters
  const raw = index.search(query, { limit: 1000, offset: 0, type: indexType });

  let filtered = raw.results;

  // Apply date filters
  if (dateFrom || dateTo) {
    filtered = filtered.filter((r) => {
      const ts = r.metadata.timestamp || r.metadata.createdAt;
      if (!ts) return true;
      const date = new Date(ts);
      if (dateFrom && date < new Date(dateFrom)) return false;
      if (dateTo && date > new Date(dateTo)) return false;
      return true;
    });
  }

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  const results = page.map((r) => ({
    id: r.metadata.conversationId || r.metadata.docId,
    conversationId: r.metadata.conversationId || r.metadata.docId,
    type: r.metadata.type,
    title: r.metadata.title,
    matchSnippet: r.snippet,
    timestamp: r.metadata.timestamp || r.metadata.createdAt || null,
    score: r.score,
  }));

  return { results, total };
}

/**
 * Fallback linear scan when index is not ready.
 */
async function linearScan(query, userId, workspaceId, options) {
  const { limit = 20, offset = 0, dateFrom, dateTo } = options;

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
        bestSnippet = extractSnippet(content, query);
      }
    }

    if (titleMatch && !bestSnippet) {
      bestSnippet = conv.title || "";
      bestScore = Math.max(bestScore, 0.5);
    }

    if (bestScore > 0) {
      matches.push({
        id: conv.id,
        conversationId: conv.id,
        type: "conversation",
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

/** Expose the raw index for testing / advanced use. */
export function getIndex() {
  return index;
}

/** Check if the index has been built. */
export function isIndexReady() {
  return indexReady;
}
